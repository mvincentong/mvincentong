#!/usr/bin/env node
/**
 * Growing contribution snake.
 *
 * Fetches a user's GitHub contribution calendar, runs a snake that eats the
 * contribution dots and grows longer as it eats, and renders the run as an
 * animated SVG (CSS animations only, so it works inside <img> on the GitHub
 * profile page).
 *
 * Usage: node scripts/generate-snake.mjs <github-user> <out-dir>
 */

const CELL = 16; // cell pitch in px
const DOT = 12; // dot size in px
const DOT_RADIUS = 2;
const STEP_MS = 100; // time per snake step
const PAUSE_MS = 4000; // hold at the end before the loop restarts
const START_LEN = 4; // snake length at spawn, in cells
const MAX_LEN = 30; // growth cap, in cells
const GROW_EVERY = 3; // grow one cell every N dots eaten
const PAD = 4; // cells of off-grid margin the snake may roam
const MAX_STEPS = 8000;

const PALETTES = {
  light: {
    empty: "#ebedf0",
    levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#7c3aed",
    background: "transparent",
  },
  dark: {
    empty: "#161b22",
    levels: ["#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "#a78bfa",
    background: "transparent",
  },
};

const key = (x, y) => `${x},${y}`;

async function fetchCalendar(user) {
  const res = await fetch(`https://github.com/users/${user}/contributions`, {
    headers: { "user-agent": "growing-snake-generator" },
  });
  if (!res.ok) {
    throw new Error(`contributions fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const cells = [];
  const tdRe = /<td[^>]*ContributionCalendar-day[^>]*>/g;
  for (const [td] of html.matchAll(tdRe)) {
    const date = td.match(/data-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const level = td.match(/data-level="(\d)"/)?.[1];
    if (!date || level === undefined) continue;
    cells.push({ date, level: Number(level) });
  }
  if (cells.length === 0) {
    throw new Error("no calendar cells parsed; contributions HTML may have changed");
  }
  cells.sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = new Date(`${cells[0].date}T00:00:00Z`);
  const firstDow = first.getUTCDay();
  return cells.map(({ date, level }) => {
    const d = new Date(`${date}T00:00:00Z`);
    const days = Math.round((d - first) / 86400000);
    return { x: Math.floor((days + firstDow) / 7), y: d.getUTCDay(), level };
  });
}

function solve(cells) {
  const width = Math.max(...cells.map((c) => c.x)) + 1;
  const dots = new Map(
    cells.filter((c) => c.level > 0).map((c) => [key(c.x, c.y), c.level]),
  );
  const inBounds = (x, y) =>
    x >= -PAD && x < width + PAD && y >= -PAD && y < 7 + PAD;
  // Like the original snk: clear the lightest remaining color first, while
  // darker (higher-level) cells act as walls the snake must route around.
  const currentLevel = () => Math.min(...dots.values());

  let body = Array.from({ length: START_LEN }, (_, i) => ({
    x: -1 - i,
    y: -1,
  }));
  const chain = [body[0]];
  const eats = []; // { step, x, y }
  const lengths = [{ step: 0, len: body.length }];
  let eaten = 0;
  let pendingGrowth = 0;

  const bfsToNearestDot = (level, strictWalls) => {
    const blocked = new Set(body.map((p) => key(p.x, p.y)));
    const queue = [body[0]];
    const cameFrom = new Map([[key(body[0].x, body[0].y), null]]);
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const k = key(nx, ny);
        if (!inBounds(nx, ny) || blocked.has(k) || cameFrom.has(k)) continue;
        if (strictWalls && (dots.get(k) ?? 0) > level) continue;
        cameFrom.set(k, cur);
        const next = { x: nx, y: ny };
        if (dots.get(k) === level) {
          const path = [next];
          let back = cur;
          while (back && cameFrom.get(key(back.x, back.y)) !== null) {
            path.unshift(back);
            back = cameFrom.get(key(back.x, back.y));
          }
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  };

  const wander = () => {
    const blocked = new Set(body.map((p) => key(p.x, p.y)));
    let best = null;
    let bestFree = -1;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nx = body[0].x + dx;
      const ny = body[0].y + dy;
      if (!inBounds(nx, ny) || blocked.has(key(nx, ny))) continue;
      let free = 0;
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inBounds(nx + ex, ny + ey) && !blocked.has(key(nx + ex, ny + ey))) {
          free += 1;
        }
      }
      if (free > bestFree) {
        bestFree = free;
        best = { x: nx, y: ny };
      }
    }
    return best ? [best] : null;
  };

  const advance = (cell) => {
    body.unshift(cell);
    const k = key(cell.x, cell.y);
    if (dots.has(k)) {
      dots.delete(k);
      eaten += 1;
      if (eaten % GROW_EVERY === 0 && body.length + pendingGrowth <= MAX_LEN) {
        pendingGrowth += 1;
      }
      eats.push({ step: chain.length, x: cell.x, y: cell.y });
    }
    if (pendingGrowth > 0) {
      pendingGrowth -= 1;
      lengths.push({ step: chain.length, len: body.length });
    } else {
      body.pop();
    }
    chain.push(cell);
  };

  while (dots.size > 0 && chain.length < MAX_STEPS) {
    const level = currentLevel();
    const path =
      bfsToNearestDot(level, true) ?? bfsToNearestDot(level, false) ?? wander();
    if (!path) break;
    for (const cell of path) {
      advance(cell);
      if (chain.length >= MAX_STEPS) break;
    }
  }
  return { width, chain, eats, lengths, dotsLeft: dots.size };
}

const fmtPct = (n) => Number(n.toFixed(3));

// Head position at step i; negative i extends the spawn line off-grid so
// tail segments have somewhere to be before the head has moved j steps.
const vchain = (chain, i) => (i >= 0 ? chain[i] : { x: -1 + i, y: -1 });

function snakeSegmentStyles(solved, stepPct, totalMs) {
  const { chain, lengths } = solved;
  const lastStep = chain.length - 1;
  const turns = [0];
  for (let i = 1; i < lastStep; i += 1) {
    const a = chain[i - 1];
    const b = chain[i];
    const c = chain[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) turns.push(i);
  }
  turns.push(lastStep);

  const finalLen = lengths[lengths.length - 1].len;
  const styles = [];
  for (let j = 0; j < finalLen; j += 1) {
    const birth =
      j < START_LEN ? 0 : lengths.find(({ len }) => len >= j + 1).step;
    const at = (step) => {
      const p = vchain(chain, step - j);
      return `transform:translate(${p.x * CELL + (CELL - DOT) / 2}px,${p.y * CELL + (CELL - DOT) / 2}px)`;
    };
    const steps = [
      birth,
      ...turns.map((s) => s + j).filter((s) => s > birth && s < lastStep),
      lastStep,
    ];
    const frames = steps.map((s) => `${stepPct(s)}%{${at(s)}}`);
    if (birth > 0) {
      frames.unshift(
        `0%,${fmtPct(stepPct(birth) - 0.01)}%{opacity:0;${at(birth)}}${stepPct(birth)}%{opacity:1}`,
      );
    }
    frames.push(`100%{${at(lastStep)}}`);
    styles.push(
      `@keyframes s${j}{${frames.join("")}}` +
        `.s${j}{animation:s${j} ${totalMs}ms linear infinite}`,
    );
  }
  return { styles, finalLen };
}

function renderSvg(cells, solved, palette) {
  const { width, chain, eats } = solved;
  const travelMs = (chain.length - 1) * STEP_MS;
  const totalMs = travelMs + PAUSE_MS;
  const stepPct = (step) => fmtPct(((step * STEP_MS) / totalMs) * 100);

  const dotRects = [];
  const dotFrames = [];
  const eatStepByKey = new Map(eats.map((e) => [key(e.x, e.y), e.step]));
  cells.forEach((c, i) => {
    const x = c.x * CELL + (CELL - DOT) / 2;
    const y = c.y * CELL + (CELL - DOT) / 2;
    const fill = c.level > 0 ? palette.levels[c.level - 1] : palette.empty;
    const eatStep = eatStepByKey.get(key(c.x, c.y));
    const cls = eatStep === undefined ? "" : ` class="d${i}"`;
    dotRects.push(
      `<rect${cls} x="${x}" y="${y}" width="${DOT}" height="${DOT}" rx="${DOT_RADIUS}" fill="${fill}"/>`,
    );
    if (eatStep !== undefined) {
      const p = stepPct(eatStep);
      dotFrames.push(
        `@keyframes d${i}{0%,${p}%{fill:${fill}}${fmtPct(p + 0.01)}%,100%{fill:${palette.empty}}}` +
          `.d${i}{animation:d${i} ${totalMs}ms linear infinite}`,
      );
    }
  });

  const { styles, finalLen } = snakeSegmentStyles(solved, stepPct, totalMs);
  const segments = Array.from({ length: finalLen }, (_, j) => {
    // Tail segments shade slightly toward transparent like the original.
    const alpha = j === 0 ? 1 : Math.max(0.5, 1 - j * 0.02);
    return `<rect class="s${j}" width="${DOT}" height="${DOT}" rx="${DOT_RADIUS + 2}" fill="${palette.snake}" fill-opacity="${alpha}"/>`;
  }).reverse();

  const w = width * CELL;
  const h = 7 * CELL;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-CELL} ${-CELL} ${w + 2 * CELL} ${h + 2 * CELL}" width="${w + 2 * CELL}" height="${h + 2 * CELL}">`,
    `<style>`,
    styles.join(""),
    dotFrames.join(""),
    `</style>`,
    palette.background === "transparent"
      ? ""
      : `<rect x="${-CELL}" y="${-CELL}" width="${w + 2 * CELL}" height="${h + 2 * CELL}" fill="${palette.background}"/>`,
    dotRects.join(""),
    segments.join(""),
    `</svg>`,
  ].join("\n");
}

async function main() {
  const [user, outDir] = process.argv.slice(2);
  if (!user || !outDir) {
    console.error("usage: generate-snake.mjs <github-user> <out-dir>");
    process.exit(1);
  }
  const { mkdir, writeFile } = await import("node:fs/promises");
  const cells = await fetchCalendar(user);
  const solved = solve(cells);
  console.log(
    `grid ${solved.width}x7, ${solved.chain.length} steps, ` +
      `${solved.eats.length} dots eaten, ${solved.dotsLeft} unreachable, ` +
      `final length ${solved.lengths[solved.lengths.length - 1].len} cells`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/github-contribution-grid-snake.svg`,
    renderSvg(cells, solved, PALETTES.light),
  );
  await writeFile(
    `${outDir}/github-contribution-grid-snake-dark.svg`,
    renderSvg(cells, solved, PALETTES.dark),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
