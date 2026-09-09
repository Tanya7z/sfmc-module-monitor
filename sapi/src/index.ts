/**
 * @sfmc-bds/module-monitor — TPS 环形采样 + 宏观负载落库
 */

import { Player, system, world } from "@minecraft/server";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Command, debug, Msg, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";

const MODULE_ID = "monitor";
const MAX_SAMPLES = 100;
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"] as const;
const METRICS_TABLE = "sfmc_monitor_metrics";
const CHUNKS_TABLE = "sfmc_monitor_player_chunks";

/** 环形墙钟毫秒戳缓冲（容量 100）。 */
const tickTimes: number[] = [];
let tickWrite = 0;
let tickCount = 0;

const unprovide: Array<() => void> = [];
let sampleRunId: number | undefined;
let reportRunId: number | undefined;
let cleanupRunId: number | undefined;
let sampleIntervalTicks = 600;
let retentionHours = 72;

export type TpsGrade = "green" | "yellow" | "gold" | "red";

/** 推入环形缓冲。 */
export function pushTickSample(now = Date.now()): void {
  if (tickCount < MAX_SAMPLES) {
    tickTimes.push(now);
    tickCount++;
    tickWrite = tickCount % MAX_SAMPLES;
  } else {
    tickTimes[tickWrite] = now;
    tickWrite = (tickWrite + 1) % MAX_SAMPLES;
  }
}

/** 当前实时 TPS，冷启动未满保底 20.00，区间 [0, 20]。 */
export function getTPS(): number {
  if (tickCount < 2) return 20;
  const samples = tickCount < MAX_SAMPLES ? tickTimes.slice(0, tickCount) : reorderRing();
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || last <= first) return 20;
  const elapsedSec = (last - first) / 1000;
  const tickSpan = samples.length - 1;
  const tps = tickSpan / elapsedSec;
  return Math.round(Math.min(Math.max(tps, 0), 20) * 100) / 100;
}

function reorderRing(): number[] {
  if (tickCount < MAX_SAMPLES) return tickTimes.slice(0, tickCount);
  return tickTimes.slice(tickWrite).concat(tickTimes.slice(0, tickWrite));
}

export function gradeOf(tps: number): TpsGrade {
  if (tps >= 19.5) return "green";
  if (tps >= 15) return "yellow";
  if (tps >= 10) return "gold";
  return "red";
}

function colorOf(grade: TpsGrade): string {
  switch (grade) {
    case "green":
      return "§a";
    case "yellow":
      return "§e";
    case "gold":
      return "§6";
    case "red":
      return "§c";
  }
}

export function getTpsStatus(): { text: string; tps: number; grade: TpsGrade } {
  const tps = getTPS();
  const grade = gradeOf(tps);
  const text = `§7[TPS] ${colorOf(grade)}${tps.toFixed(2)} §7/ 20.00`;
  return { text, tps, grade };
}

function snapshotEntities(): Record<string, number> {
  const entities: Record<string, number> = {};
  for (const dim of DIMENSIONS) {
    try {
      entities[dim] = world.getDimension(dim).getEntities().length;
    } catch {
      entities[dim] = 0;
    }
  }
  return entities;
}

function snapshotPlayerChunks(): Array<Record<string, unknown>> {
  return world.getAllPlayers().map((p: Player) => {
    const loc = p.location;
    const dim = p.dimension?.id || "minecraft:overworld";
    const rd = p.clientSystemInfo?.maxRenderDistance ?? 8;
    const side = rd + 1;
    return {
      player_id: p.id,
      player_name: p.name,
      dimension: dim,
      pos_x: Math.round(loc.x),
      pos_y: Math.round(loc.y),
      pos_z: Math.round(loc.z),
      render_distance: rd,
      chunk_estimate: (1 + side) * (1 + side),
      updated_at: Date.now(),
    };
  });
}

function totalLoadedChunks(chunks: Array<Record<string, unknown>>): number {
  return chunks.reduce((s, r) => s + (Number(r.chunk_estimate) || 0), 0);
}

export function buildMetricsSnapshot(): {
  tps: number;
  grade: TpsGrade;
  entities: Record<string, number>;
  totalLoadedChunks: number;
} {
  const tps = getTPS();
  const chunks = snapshotPlayerChunks();
  return {
    tps,
    grade: gradeOf(tps),
    entities: snapshotEntities(),
    totalLoadedChunks: totalLoadedChunks(chunks),
  };
}

async function persistSnapshot(): Promise<void> {
  const tps = getTPS();
  const entities = snapshotEntities();
  const recordedAt = Date.now();
  const playerChunks = snapshotPlayerChunks();

  await db.tx(async (tx) => {
    for (const [dim, count] of Object.entries(entities)) {
      await tx.insert(METRICS_TABLE, {
        id: `${recordedAt}-${dim}`,
        recorded_at: recordedAt,
        tps,
        dimension: dim,
        entity_count: count,
      });
    }
    for (const row of playerChunks) {
      await tx.insert(CHUNKS_TABLE, {
        ...row,
        id: `${recordedAt}-${String(row.player_id)}`,
      });
    }
  });
}

async function pruneHistory(): Promise<void> {
  const cutoff = Date.now() - retentionHours * 3600_000;
  try {
    const oldMetrics = await db.query<{ id: string }>(METRICS_TABLE, {
      where: { lt: ["recorded_at", cutoff] },
      limit: 500,
    });
    const oldChunks = await db.query<{ id: string }>(CHUNKS_TABLE, {
      where: { lt: ["updated_at", cutoff] },
      limit: 500,
    });
    if (oldMetrics.length === 0 && oldChunks.length === 0) return;
    await db.tx(async (tx) => {
      for (const row of oldMetrics) await tx.delete(METRICS_TABLE, row.id);
      for (const row of oldChunks) await tx.delete(CHUNKS_TABLE, row.id);
    });
  } catch (err) {
    debug.e("Monitor", "prune failed", err instanceof Error ? err : new Error(String(err)));
  }
}

function registerCommands(): void {
  Command.register(
    "tps",
    "tps.see",
    (player: Player | undefined) => {
      const { text } = getTpsStatus();
      if (player) Msg.info(text, player);
      else debug.i("Monitor", text);
    },
    "查看服务器 TPS",
    MODULE_ID
  );
  Command.register(
    "monitor",
    "monitor.admin",
    (player: Player | undefined) => {
      const snap = buildMetricsSnapshot();
      const lines = [
        `§e===== 服务器监控 =====`,
        getTpsStatus().text,
        `§7主世界实体: §f${snap.entities["minecraft:overworld"] ?? 0}`,
        `§7下界实体: §f${snap.entities["minecraft:nether"] ?? 0}`,
        `§7末地实体: §f${snap.entities["minecraft:the_end"] ?? 0}`,
        `§7视距区块估算: §f${snap.totalLoadedChunks}`,
        `§e====================`,
      ].join("\n");
      if (player) Msg.info(lines, player);
      else debug.i("Monitor", lines);
    },
    "查看服务器综合负载",
    MODULE_ID
  );
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("tps.see", Permission.Any);
      Permission.register("monitor.admin", Permission.Admin);
    },
    registerEvents() {
      // 采样由 interval 驱动
    },
    async init() {
      const interval = await config.get<number>("sample_interval_ticks");
      const retention = await config.get<number>("history_retention_hours");
      if (typeof interval === "number" && interval > 0) sampleIntervalTicks = interval;
      if (typeof retention === "number" && retention > 0) retentionHours = retention;

      await db.defineTable(METRICS_TABLE, {
        id: { type: "TEXT", primary: true },
        recorded_at: { type: "INTEGER", notNull: true, index: true },
        tps: { type: "REAL", notNull: true },
        dimension: { type: "TEXT", notNull: true },
        entity_count: { type: "INTEGER", default: 0 },
      });
      await db.defineTable(CHUNKS_TABLE, {
        id: { type: "TEXT", primary: true },
        player_id: { type: "TEXT", notNull: true },
        player_name: { type: "TEXT", notNull: true },
        dimension: { type: "TEXT", notNull: true },
        pos_x: { type: "INTEGER", default: 0 },
        pos_y: { type: "INTEGER", default: 0 },
        pos_z: { type: "INTEGER", default: 0 },
        render_distance: { type: "INTEGER", default: 0 },
        chunk_estimate: { type: "INTEGER", default: 0 },
        updated_at: { type: "INTEGER", notNull: true, index: true },
      });

      sampleRunId = system.runInterval(() => pushTickSample(), 1);
      reportRunId = system.runInterval(() => {
        void persistSnapshot().catch((e) =>
          debug.e("Monitor", "persist failed", e instanceof Error ? e : new Error(String(e)))
        );
      }, sampleIntervalTicks);
      cleanupRunId = system.runInterval(() => void pruneHistory(), 72000);

      unprovide.push(service.provide("tps.current", () => getTPS()));
      unprovide.push(service.provide("tps.status", () => getTpsStatus()));
      unprovide.push(service.provide("monitor.metrics", () => buildMetricsSnapshot()));

      debug.i("Monitor", `init interval=${sampleIntervalTicks}`);
    },
    cleanup() {
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const id of [sampleRunId, reportRunId, cleanupRunId]) {
        if (id === undefined) continue;
        try {
          system.clearRun(id);
        } catch {
          /* ignore */
        }
      }
      sampleRunId = reportRunId = cleanupRunId = undefined;
      tickTimes.length = 0;
      tickWrite = 0;
      tickCount = 0;
      debug.i("Monitor", "cleanup");
    },
  },
});
