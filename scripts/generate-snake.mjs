#!/usr/bin/env node
/**
 * Contribution snake that spells a name as it eats.
 *
 * The snake behaves like the original snk (4 cells, eats the lightest color
 * first while darker cells act as walls). As eating progresses, the letters
 * of WORD pop onto the grid one by one — by the time the graph is eaten the
 * full name is spelled out, and the snake slithers off so the word holds.
 *
 * Renders as an animated SVG (CSS animations only, so it works inside <img>
 * on the GitHub profile page).
 *
 * Usage: node scripts/generate-snake.mjs <github-user> <out-dir>
 */

const WORD = "VINCENT";

const CELL = 16; // cell pitch in px
const DOT = 12; // dot size in px
const DOT_RADIUS = 2;
const STEP_MS = 100; // time per snake step
const PAUSE_MS = 6000; // hold the finished word before the loop restarts
const SNAKE_LEN = 4; // snake length in cells, like the original
const PAD = 4; // cells of off-grid margin the snake may roam
const MAX_STEPS = 8000;

const PALETTES = {
  light: {
    empty: "#ebedf0",
    levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "purple",
    word: "#216e39",
  },
  dark: {
    empty: "#161b22",
    levels: ["#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "purple",
    word: "#39d353",
  },
};

const FONT = {
  V: ["X...X", "X...X", "X...X", ".X.X.", "..X.."],
  I: ["XXX", ".X.", ".X.", ".X.", "XXX"],
  N: ["X..X", "XX.X", "X.XX", "X..X", "X..X"],
  C: [".XXX", "X...", "X...", "X...", ".XXX"],
  E: ["XXX", "X..", "XXX", "X..", "XXX"],
  T: ["XXX", ".X.", ".X.", ".X.", ".X."],
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

// Letter cell groups, left to right, centered on the grid.
function wordTargets(width) {
  const glyphs = [...WORD].map((ch) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for "${ch}"`);
    return glyph;
  });
  const wordWidth =
    glyphs.reduce((sum, g) => sum + g[0].length, 0) + glyphs.length - 1;
  let x0 = Math.max(0, Math.floor((width - wordWidth) / 2));
  const groups = [];
  for (const glyph of glyphs) {
    const group = [];
    glyph.forEach((row, dy) => {
      [...row].forEach((px, dx) => {
        if (px === "X") group.push({ x: x0 + dx, y: 1 + dy });
      });
    });
    groups.push(group);
    x0 += glyph[0].length + 1;
  }
  return groups;
}

function solve(cells) {
  const width = Math.max(...cells.map((c) => c.x)) + 1;
  const dots = new Map(
    cells.filter((c) => c.level > 0).map((c) => [key(c.x, c.y), c.level]),
  );
  const inBounds = (x, y) =>
    x >= -PAD && x < width + PAD && y >= -PAD && y < 7 + PAD;

  const body = Array.from({ length: SNAKE_LEN }, (_, i) => ({
    x: -1 - i,
    y: -1,
  }));
  const chain = [body[0]];
  const eats = []; // { step, x, y }

  // BFS from the head to the nearest cell satisfying isTarget, avoiding
  // walls. A body cell j segments from the head blocks the path only if the
  // path would arrive before the tail has vacated it. In ghost mode the body
  // is ignored entirely (last-resort escape). Returns the path excluding the
  // head, or null.
  const bfs = (isTarget, isWall, ghost = false) => {
    const bodyIndex = new Map(body.map((p, j) => [key(p.x, p.y), j]));
    const queue = [{ ...body[0], d: 0 }];
    const cameFrom = new Map([[key(body[0].x, body[0].y), null]]);
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const d = cur.d + 1;
        const k = key(nx, ny);
        if (!inBounds(nx, ny) || cameFrom.has(k)) continue;
        const j = bodyIndex.get(k);
        if (!ghost && j !== undefined && d < body.length - j) continue;
        if (isWall(k) && !isTarget(k)) continue;
        cameFrom.set(k, cur);
        const next = { x: nx, y: ny };
        if (isTarget(k)) {
          const path = [next];
          let back = cur;
          while (back && cameFrom.get(key(back.x, back.y)) !== null) {
            path.unshift(back);
            back = cameFrom.get(key(back.x, back.y));
          }
          return path;
        }
        queue.push({ ...next, d });
      }
    }
    return null;
  };

  const advance = (cell) => {
    body.unshift(cell);
    body.pop();
    const k = key(cell.x, cell.y);
    if (dots.delete(k)) {
      eats.push({ step: chain.length, x: cell.x, y: cell.y });
    }
    chain.push(cell);
  };

  // Eat everything, lightest color first, darker cells as walls.
  while (dots.size > 0 && chain.length < MAX_STEPS) {
    const level = Math.min(...dots.values());
    const isLevel = (k) => dots.get(k) === level;
    const isWall = (k) => (dots.get(k) ?? 0) > level;
    const path =
      bfs(isLevel, isWall) ??
      bfs(isLevel, () => false) ??
      bfs(isLevel, () => false, true);
    if (!path) break;
    for (const cell of path) {
      advance(cell);
      if (chain.length >= MAX_STEPS) break;
    }
  }

  // Slither off the right edge so the finished word stays clean.
  {
    const exitX = width + 3;
    const exitKeys = new Set();
    for (let y = -PAD; y < 7 + PAD; y += 1) exitKeys.add(key(exitX, y));
    const path =
      bfs((k) => exitKeys.has(k), () => false) ??
      bfs((k) => exitKeys.has(k), () => false, true);
    for (const cell of path ?? []) advance(cell);
  }

  // The word appears letter by letter, keyed to eating progress: letter i
  // pops in once (i+1)/n of the dots have been eaten.
  const letterGroups = wordTargets(width);
  const deposits = [];
  letterGroups.forEach((group, i) => {
    const milestone = Math.ceil(((i + 1) / letterGroups.length) * eats.length);
    const step = eats[Math.max(0, milestone - 1)]?.step ?? chain.length - 1;
    for (const { x, y } of group) deposits.push({ step, x, y });
  });

  return { width, chain, eats, deposits, dotsLeft: dots.size };
}

const fmtPct = (n) => Number(n.toFixed(3));

// Head position at step i; negative i extends the spawn line off-grid so
// tail segments have somewhere to be before the head has moved j steps.
const vchain = (chain, i) => (i >= 0 ? chain[i] : { x: -1 + i, y: -1 });

function snakeSegmentStyles(solved, stepPct, totalMs) {
  const { chain } = solved;
  const lastStep = chain.length - 1;
  const turns = [];
  for (let i = 1; i < lastStep; i += 1) {
    const a = chain[i - 1];
    const b = chain[i];
    const c = chain[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) turns.push(i);
  }

  const styles = [];
  for (let j = 0; j < SNAKE_LEN; j += 1) {
    const at = (step) => {
      const p = vchain(chain, step - j);
      return `transform:translate(${p.x * CELL}px,${p.y * CELL}px)`;
    };
    const frames = [
      `0%{${at(0)}}`,
      ...turns
        .map((s) => s + j)
        .filter((s) => s > 0 && s < lastStep)
        .map((s) => `${stepPct(s)}%{${at(s)}}`),
      // Fade out once the snake has slithered off-grid so the word holds.
      `${stepPct(lastStep)}%{opacity:1;${at(lastStep)}}`,
      `${fmtPct(stepPct(lastStep) + 0.5)}%,100%{opacity:0;${at(lastStep)}}`,
    ];
    styles.push(
      `@keyframes s${j}{${frames.join("")}}` +
        `.s${j}{animation:s${j} ${totalMs}ms linear infinite}`,
    );
  }
  return styles;
}

function renderSvg(cells, solved, palette) {
  const { width, chain, eats, deposits } = solved;
  const travelMs = (chain.length - 1) * STEP_MS;
  const totalMs = travelMs + PAUSE_MS;
  const stepPct = (step) => fmtPct(((step * STEP_MS) / totalMs) * 100);

  const dotRects = [];
  const frames = [];
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
      frames.push(
        `@keyframes d${i}{0%,${p}%{fill:${fill}}${fmtPct(p + 0.01)}%,100%{fill:${palette.empty}}}` +
          `.d${i}{animation:d${i} ${totalMs}ms linear infinite}`,
      );
    }
  });

  const depositRects = deposits.map(({ step, x, y }, i) => {
    const p = stepPct(step);
    frames.push(
      `@keyframes w${i}{0%,${fmtPct(p - 0.01)}%{opacity:0}${fmtPct(p + 0.5)}%,100%{opacity:1}}` +
        `.w${i}{animation:w${i} ${totalMs}ms linear infinite}`,
    );
    return `<rect class="w${i}" x="${x * CELL + (CELL - DOT) / 2}" y="${y * CELL + (CELL - DOT) / 2}" width="${DOT}" height="${DOT}" rx="${DOT_RADIUS}" fill="${palette.word}"/>`;
  });

  // Same sizing as the original snk: a slightly bigger head tapering down
  // over the first four segments, uniform color.
  const segments = Array.from({ length: SNAKE_LEN }, (_, j) => {
    const dMin = DOT * 0.8;
    const dMax = CELL * 0.9;
    const iMax = Math.min(4, SNAKE_LEN);
    const u = (1 - Math.min(j, iMax) / iMax) ** 2;
    const s = dMin + u * (dMax - dMin);
    const m = ((CELL - s) / 2).toFixed(1);
    const r = Math.min(4.5, (4 * s) / DOT).toFixed(1);
    return `<rect class="s${j}" x="${m}" y="${m}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" rx="${r}" fill="${palette.snake}"/>`;
  }).reverse();

  const w = width * CELL;
  const h = 7 * CELL;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-CELL} ${-CELL} ${w + 2 * CELL} ${h + 2 * CELL}" width="${w + 2 * CELL}" height="${h + 2 * CELL}">`,
    `<style>`,
    snakeSegmentStyles(solved, stepPct, totalMs).join(""),
    frames.join(""),
    `</style>`,
    dotRects.join(""),
    depositRects.join(""),
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
      `${solved.eats.length} dots eaten (${solved.dotsLeft} unreachable), ` +
      `${solved.deposits.length} word cubes`,
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
