// main.ts is mend, the CLI SPEC.md specifies (MIT).
// Node 22 and its standard library alone; run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noEol?: boolean;
}

type Tier = 0 | 1 | 2;

const blank = (s: string): boolean => s.trim() === '';
const stripEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothST = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripEndST(a) === stripEndST(b);
  return stripBothST(a) === stripBothST(b);
}

function matchAt(fileLines: string[], target: string[], pos: number, tier: Tier): boolean {
  if (pos < 0 || pos + target.length > fileLines.length) return false;
  for (let k = 0; k < target.length; k += 1) {
    if (!lineEq(fileLines[pos + k]!, target[k]!, tier)) return false;
  }
  return true;
}

function findOccurrences(fileLines: string[], target: string[], tier: Tier, start = 0): number[] {
  const hits: number[] = [];
  const limit = fileLines.length - target.length;
  for (let i = start; i <= limit; i += 1) {
    if (matchAt(fileLines, target, i, tier)) hits.push(i);
  }
  return hits;
}

function reindent(line: string, fileIndent: string, patchIndent: string): string {
  if (line.trim() !== '' && line.startsWith(patchIndent)) {
    return fileIndent + line.slice(patchIndent.length);
  }
  return line;
}

function buildReplacement(ops: Op[], fileLines: string[], matchPos: number, oldFirst: string, tier: Tier): string[] {
  const fileIndent = leadST(fileLines[matchPos]!);
  const patchIndent = leadST(oldFirst);
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[matchPos + oIdx]!);
      oIdx += 1;
    } else if (op.kind === 'del') {
      oIdx += 1;
    } else {
      out.push(tier === 2 ? reindent(op.text, fileIndent, patchIndent) : op.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 6: Unified diffs */
interface UnifiedHunk {
  oldStart: number;
  ops: Op[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  hasMinusPlus: boolean;
  minusPath: string | null;
  plusPath: string | null;
  oldIsDevNull: boolean;
  newIsDevNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedHeaderPath(rawAfter4: string): { path: string; isDevNull: boolean } {
  const tab = rawAfter4.indexOf('\t');
  const part = (tab >= 0 ? rawAfter4.slice(0, tab) : rawAfter4).trim();
  if (part === '/dev/null') return { path: '/dev/null', isDevNull: true };
  if (part.startsWith('a/') || part.startsWith('b/')) {
    return { path: part.slice(2), isDevNull: false };
  }
  return { path: part, isDevNull: false };
}

function applyUnifiedHunks(f: FileLines, hunks: UnifiedHunk[], path: string, tiers: Tier[]): void {
  let d = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let lastN: Op | null = null;
    for (const op of hunk.ops) {
      if (op.kind === 'ctx') {
        oldLines.push(op.text);
        newLines.push(op.text);
        lastN = op;
      } else if (op.kind === 'del') {
        oldLines.push(op.text);
      } else {
        newLines.push(op.text);
        lastN = op;
      }
    }
    const noEolAfterLastN = lastN !== null && lastN.noEol === true;

    if (oldLines.length === 0) {
      const insertAt = Math.max(0, Math.min(f.lines.length, hunk.oldStart + d));
      const atEnd = insertAt === f.lines.length;
      f.lines.splice(insertAt, 0, ...newLines);
      if (atEnd) f.final = !noEolAfterLastN;
      d += newLines.length;
    } else {
      let chosenTier: Tier | null = null;
      let hits: number[] = [];
      for (const tier of tiers) {
        const found = findOccurrences(f.lines, oldLines, tier, 0);
        if (found.length > 0) {
          chosenTier = tier;
          hits = found;
          break;
        }
      }
      if (chosenTier === null) throw new Fail('no-match', path);
      const targetPos = hunk.oldStart - 1 + d;
      let bestPos = hits[0]!;
      let bestDist = Math.abs(bestPos - targetPos);
      for (let k = 1; k < hits.length; k += 1) {
        const pos = hits[k]!;
        const dist = Math.abs(pos - targetPos);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const runsToEnd = bestPos + oldLines.length === f.lines.length;
      const replacement = buildReplacement(hunk.ops, f.lines, bestPos, oldLines[0]!, chosenTier);
      f.lines.splice(bestPos, oldLines.length, ...replacement);
      if (runsToEnd) f.final = !noEolAfterLastN;
      d += newLines.length - oldLines.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        hasMinusPlus: false,
        minusPath: null,
        plusPath: null,
        oldIsDevNull: false,
        newIsDevNull: false,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDel: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }

    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const mp = parseUnifiedHeaderPath(l.slice(4));
        const pp = parseUnifiedHeaderPath(next.slice(4));
        if (cur === null || !inHeader || cur.hasMinusPlus) {
          cur = {
            gitOld: null,
            gitNew: null,
            hasMinusPlus: true,
            minusPath: mp.path,
            plusPath: pp.path,
            oldIsDevNull: mp.isDevNull,
            newIsDevNull: pp.isDevNull,
            renameFrom: null,
            renameTo: null,
            isNew: false,
            isDel: false,
            hunks: [],
          };
          sections.push(cur);
          inHeader = true;
        } else {
          cur.hasMinusPlus = true;
          cur.minusPath = mp.path;
          cur.plusPath = pp.path;
          cur.oldIsDevNull = mp.isDevNull;
          cur.newIsDevNull = pp.isDevNull;
        }
        i += 2;
        continue;
      }
      if (inHeader && !cur!.hasMinusPlus) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }

    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;
      const ops: Op[] = [];
      let lastOp: Op | null = null;
      let trailingEmpty = 0;

      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          const op: Op = { kind: 'ctx', text: '', noEol: false };
          ops.push(op);
          lastOp = op;
          trailingEmpty += 1;
          i += 1;
        } else if (bl[0] === ' ') {
          const op: Op = { kind: 'ctx', text: bl.slice(1), noEol: false };
          ops.push(op);
          lastOp = op;
          trailingEmpty = 0;
          i += 1;
        } else if (bl[0] === '-') {
          const op: Op = { kind: 'del', text: bl.slice(1), noEol: false };
          ops.push(op);
          lastOp = op;
          trailingEmpty = 0;
          i += 1;
        } else if (bl[0] === '+') {
          const op: Op = { kind: 'add', text: bl.slice(1), noEol: false };
          ops.push(op);
          lastOp = op;
          trailingEmpty = 0;
          i += 1;
        } else if (bl[0] === '\\') {
          if (lastOp !== null) lastOp.noEol = true;
          trailingEmpty = 0;
          i += 1;
        } else {
          break;
        }
      }

      if (trailingEmpty > 0) ops.splice(ops.length - trailingEmpty, trailingEmpty);
      cur.hunks.push({ oldStart, ops });
      continue;
    }

    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isNew = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDel = true;
    }
    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.hasMinusPlus ? sec.minusPath! : (sec.renameFrom ?? sec.gitOld ?? '');
    const newPath = sec.hasMinusPlus ? sec.plusPath! : (sec.renameTo ?? sec.gitNew ?? '');
    const isCreate = sec.oldIsDevNull || sec.isNew;
    const isDelete = !isCreate && (sec.newIsDevNull || sec.isDel);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      const plusLines: string[] = [];
      let lastPlus: Op | null = null;
      for (const hunk of sec.hunks) {
        for (const op of hunk.ops) {
          if (op.kind === 'add') {
            plusLines.push(op.text);
            lastPlus = op;
          }
        }
      }
      const noEol = lastPlus !== null && lastPlus.noEol === true;
      const content = plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n');
      return (tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, content);
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }

    if (isMove) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const f = splitFile(before);
        applyUnifiedHunks(f, sec.hunks, oldPath, tiers);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinFile(f));
        tree.moves.push([oldPath, newPath]);
      };
    }

    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const f = splitFile(before);
      applyUnifiedHunks(f, sec.hunks, oldPath, tiers);
      tree.now.set(oldPath, joinFile(f));
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }

    const searchIdx = i;
    let foundPath: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const candidate = lines[j]!;
      if (blank(candidate)) continue;
      const trimmed = candidate.trim();
      if (trimmed.startsWith('```')) continue;
      foundPath = trimmed;
      break;
    }
    const path = foundPath ?? prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let repIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, repIdx);
    prevPath = path;
    prevEnd = repIdx;
    i = repIdx + 1;

    if (oldLines.length === 0) {
      const content = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content);
      });
    } else {
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        const f = splitFile(before);
        let chosenTier: Tier | null = null;
        let hits: number[] = [];
        for (const tier of tiers) {
          const found = findOccurrences(f.lines, oldLines, tier, 0);
          if (found.length > 0) {
            chosenTier = tier;
            hits = found;
            break;
          }
        }
        if (chosenTier === null) throw new Fail('no-match', path);
        if (hits.length > 1) throw new Fail('ambiguous', path);
        const pos = hits[0]!;
        let replacement: string[];
        if (chosenTier === 2) {
          const fileIndent = leadST(f.lines[pos]!);
          const patchIndent = leadST(oldLines[0]!);
          replacement = newLines.map((nl) => reindent(nl, fileIndent, patchIndent));
        } else {
          replacement = newLines;
        }
        f.lines.splice(pos, oldLines.length, ...replacement);
        tree.now.set(path, joinFile(f));
      });
    }
  }

  return edits;
}

/** Section 8: V4A patches */
interface V4AChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    body: Array<{ lineNum: number; text: string }>;
  }

  const rawSections: RawSection[] = [];
  let cur: RawSection | null = null;

  for (let i = first + 1; i < last; i += 1) {
    const text = lines[i]!;
    const lineNum = i + 1;
    if (text.startsWith('*** Add File: ')) {
      cur = { kind: 'add', path: text.slice('*** Add File: '.length).trim(), headerLine: lineNum, body: [] };
      rawSections.push(cur);
    } else if (text.startsWith('*** Delete File: ')) {
      cur = { kind: 'delete', path: text.slice('*** Delete File: '.length).trim(), headerLine: lineNum, body: [] };
      rawSections.push(cur);
    } else if (text.startsWith('*** Update File: ')) {
      cur = { kind: 'update', path: text.slice('*** Update File: '.length).trim(), headerLine: lineNum, body: [] };
      rawSections.push(cur);
    } else if (cur === null) {
      if (!blank(text)) throw new Exit2(`error: parse ${lineNum}`);
    } else {
      cur.body.push({ lineNum, text });
    }
  }

  const edits: Edit[] = [];

  for (const sec of rawSections) {
    while (sec.body.length > 0 && blank(sec.body[sec.body.length - 1]!.text)) {
      sec.body.pop();
    }

    if (sec.kind === 'add') {
      const addLines: string[] = [];
      for (const item of sec.body) {
        if (item.text.startsWith('+')) addLines.push(item.text.slice(1));
        else if (item.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${item.lineNum}`);
      }
      const content = addLines.length === 0 ? '' : addLines.join('\n') + '\n';
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
    } else if (sec.kind === 'delete') {
      if (sec.body.length > 0) throw new Exit2(`error: parse ${sec.body[0]!.lineNum}`);
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (idx < sec.body.length && sec.body[idx]!.text.startsWith('*** Move to: ')) {
        moveTo = sec.body[idx]!.text.slice('*** Move to: '.length).trim();
        idx += 1;
      }

      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;

      for (; idx < sec.body.length; idx += 1) {
        const { lineNum, text } = sec.body[idx]!;
        if (text.startsWith('@@')) {
          const anchorText = text.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false };
          chunks.push(curChunk);
        } else if (text.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${lineNum}`);
          curChunk.eof = true;
          curChunk = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNum}`);
            curChunk = { anchor: null, ops: [], eof: false };
            chunks.push(curChunk);
          }
          if (text === '') curChunk.ops.push({ kind: 'ctx', text: '' });
          else if (text[0] === ' ') curChunk.ops.push({ kind: 'ctx', text: text.slice(1) });
          else if (text[0] === '-') curChunk.ops.push({ kind: 'del', text: text.slice(1) });
          else curChunk.ops.push({ kind: 'add', text: text.slice(1) });
        } else {
          throw new Exit2(`error: parse ${lineNum}`);
        }
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${sec.headerLine}`);
      }

      const p = sec.path;
      const dest = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);

        const f = splitFile(before);
        let cursor = 0;

        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            let foundAnchor = -1;
            for (const tier of tiers) {
              for (let pos = cursor; pos < f.lines.length; pos += 1) {
                if (lineEq(f.lines[pos]!, chunk.anchor, tier)) {
                  foundAnchor = pos;
                  break;
                }
              }
              if (foundAnchor >= 0) break;
            }
            if (foundAnchor < 0) throw new Fail('no-match', p);
            cursor = foundAnchor + 1;
          }

          const oldLines: string[] = [];
          const addOnly: string[] = [];
          for (const op of chunk.ops) {
            if (op.kind === 'ctx' || op.kind === 'del') oldLines.push(op.text);
            if (op.kind === 'add') addOnly.push(op.text);
          }

          if (oldLines.length === 0) {
            const insertPos = chunk.eof ? f.lines.length : cursor;
            f.lines.splice(insertPos, 0, ...addOnly);
            cursor = insertPos + addOnly.length;
          } else {
            let matchPos = -1;
            let chosenTier: Tier | null = null;
            for (const tier of tiers) {
              if (chunk.eof) {
                const cand = f.lines.length - oldLines.length;
                if (cand >= cursor && matchAt(f.lines, oldLines, cand, tier)) {
                  matchPos = cand;
                  chosenTier = tier;
                  break;
                }
              } else {
                const limit = f.lines.length - oldLines.length;
                for (let pos = cursor; pos <= limit; pos += 1) {
                  if (matchAt(f.lines, oldLines, pos, tier)) {
                    matchPos = pos;
                    chosenTier = tier;
                    break;
                  }
                }
                if (matchPos >= 0) break;
              }
            }
            if (matchPos < 0 || chosenTier === null) throw new Fail('no-match', p);
            const replacement = buildReplacement(chunk.ops, f.lines, matchPos, oldLines[0]!, chosenTier);
            f.lines.splice(matchPos, oldLines.length, ...replacement);
            cursor = matchPos + replacement.length;
          }
        }

        const out = joinFile(f);
        if (dest !== null) {
          tree.now.set(p, null);
          tree.now.set(dest, out);
          tree.moves.push([p, dest]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }

  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const prevMovesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = prevMovesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const claimedOld = new Set<string>();
  const claimedNew = new Set<string>();
  const rows: Array<{ sortKey: string; line: string }> = [];

  for (const [oldP, newP] of tree.moves) {
    if (claimedOld.has(oldP) || claimedNew.has(newP)) continue;
    const oldWas = tree.original(oldP);
    const oldNow = tree.get(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.get(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      claimedOld.add(oldP);
      claimedNew.add(newP);
      rows.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
    }
  }

  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && claimedOld.has(p)) continue;
    if (was === null && now !== null && claimedNew.has(p)) continue;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));

  if (!check) {
    const changed = [...tree.now.keys()]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .filter((p) => tree.original(p) !== tree.now.get(p)!);
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
