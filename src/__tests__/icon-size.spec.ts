/**
 * Every assistant glyph sits in its viewBox at the inset of JupyterLab's own
 * icons (DEF-PANE-332).
 *
 * The Launcher card, the sidebar tab and the menus draw every icon in one box
 * size, so how big a glyph looks there is fixed by the SVG alone: the share of
 * the viewBox its drawn paths cover. The reference is measured from
 * JupyterLab's terminal icon, the Terminal card of the same Launcher, rather
 * than written down, and each provider glyph is measured the same way.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PROVIDERS } from '../providers';

/** Largest allowed difference, as a share of the viewBox side - half a pixel
 * of the Launcher card's 52px icon box. */
const TOLERANCE = 0.01;

/** Samples per curve or arc; the extent error is far below the tolerance. */
const STEPS = 64;

type Point = [number, number];

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/** Points along an arc in the SVG endpoint parameterisation (SVG 1.1 F.6.5). */
function arcPoints(
  [x1, y1]: Point,
  rxIn: number,
  ryIn: number,
  degrees: number,
  large: boolean,
  sweep: boolean,
  [x2, y2]: Point
): Point[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    return [[x2, y2]];
  }
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let delta = angle(
    (xp - cxp) / rx,
    (yp - cyp) / ry,
    (-xp - cxp) / rx,
    (-yp - cyp) / ry
  );
  if (!sweep && delta > 0) {
    delta -= 2 * Math.PI;
  } else if (sweep && delta < 0) {
    delta += 2 * Math.PI;
  }
  const points: Point[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = start + (delta * i) / STEPS;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    points.push([cx + ex * cos - ey * sin, cy + ex * sin + ey * cos]);
  }
  return points;
}

/** Points along a Bezier curve of any order, its start excluded. */
function bezierPoints(controls: Point[]): Point[] {
  const points: Point[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    let level = controls;
    while (level.length > 1) {
      level = level
        .slice(1)
        .map(([x, y], k): Point => [
          level[k][0] + (x - level[k][0]) * t,
          level[k][1] + (y - level[k][1]) * t
        ]);
    }
    points.push(level[0]);
  }
  return points;
}

/** Every vertex of a path's `d`, with curves and arcs sampled. */
function pathPoints(d: string): Point[] {
  let i = 0;
  const skip = (): void => {
    while (i < d.length && /[\s,]/.test(d[i])) {
      i++;
    }
  };
  const number = (): number => {
    skip();
    const match = NUMBER.exec(d.slice(i));
    if (!match) {
      throw new Error(`no number at ${i} of ${d}`);
    }
    i += match[0].length;
    return parseFloat(match[0]);
  };
  // An arc flag is one digit and may touch the next number ("0 01.9").
  const flag = (): boolean => {
    skip();
    return d[i++] === '1';
  };

  const points: Point[] = [];
  let at: Point = [0, 0];
  let start: Point = [0, 0];
  // The last control point, for the reflected control of S and T.
  let control: Point = [0, 0];
  let command = '';
  for (skip(); i < d.length; skip()) {
    if (/[A-Za-z]/.test(d[i])) {
      command = d[i++];
    } else if (command === 'M' || command === 'm') {
      // Pairs after a moveto are linetos.
      command = command === 'M' ? 'L' : 'l';
    } else if (command === 'Z' || command === 'z' || command === '') {
      throw new Error(`a number with no command at ${i} of ${d}`);
    }
    const relative = command === command.toLowerCase();
    const point = (): Point => {
      const x = number();
      const y = number();
      return relative ? [at[0] + x, at[1] + y] : [x, y];
    };
    const kind = command.toUpperCase();
    let next: Point = at;
    let segment: Point[] = [];
    if (kind === 'Z') {
      next = start;
      segment = [start];
    } else if (kind === 'M') {
      next = start = point();
      segment = [next];
    } else if (kind === 'L') {
      next = point();
      segment = [next];
    } else if (kind === 'H') {
      next = [number() + (relative ? at[0] : 0), at[1]];
      segment = [next];
    } else if (kind === 'V') {
      next = [at[0], number() + (relative ? at[1] : 0)];
      segment = [next];
    } else if (kind === 'C' || kind === 'S' || kind === 'Q' || kind === 'T') {
      const smooth = kind === 'S' || kind === 'T';
      const first: Point = smooth
        ? [2 * at[0] - control[0], 2 * at[1] - control[1]]
        : point();
      const second = kind === 'C' || kind === 'S' ? point() : first;
      next = point();
      control = kind === 'C' || kind === 'S' ? second : first;
      segment = bezierPoints(
        kind === 'C' || kind === 'S'
          ? [at, first, second, next]
          : [at, first, next]
      );
    } else if (kind === 'A') {
      const rx = number();
      const ry = number();
      const degrees = number();
      const large = flag();
      const sweep = flag();
      next = point();
      segment = arcPoints(at, rx, ry, degrees, large, sweep, next);
    } else {
      throw new Error(`unsupported command ${command} in ${d}`);
    }
    if (!/[CSQT]/.test(kind)) {
      control = next;
    }
    points.push(...segment);
    at = next;
  }
  return points;
}

interface IExtent {
  /** The viewBox: x, y, width, height. */
  viewBox: number[];
  /** The bounding box of every drawn path: x, y, width, height. */
  art: number[];
}

/** The drawn extent of an SVG's paths against its viewBox. */
function measure(svg: string): IExtent {
  const viewBox = /viewBox="([^"]+)"/
    .exec(svg)![1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const points: Point[] = [];
  const paths = /\bd="([^"]+)"/g;
  for (let match = paths.exec(svg); match; match = paths.exec(svg)) {
    points.push(...pathPoints(match[1]));
  }
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    viewBox,
    art: [x, y, Math.max(...xs) - x, Math.max(...ys) - y]
  };
}

/** The larger side of the art as a share of the viewBox side. */
function share({ viewBox, art }: IExtent): number {
  return Math.max(art[2], art[3]) / viewBox[2];
}

// JupyterLab's terminal icon: the glyph of the Launcher's Terminal card.
const terminalSvg = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('@jupyterlab/ui-components/package.json')),
    'style/icons/statusbar/terminal.svg'
  ),
  'utf8'
);
const REFERENCE = share(measure(terminalSvg));

const glyphs = PROVIDERS.map(module => [
  module.descriptor.id,
  measure(module.descriptor.iconSvg)
]) as [string, IExtent][];

describe('DEF-PANE-332 - assistant glyphs at the JupyterLab icon inset', () => {
  it.each(glyphs)('%s: the viewBox is square', (_id, { viewBox }) => {
    expect(viewBox[2]).toBe(viewBox[3]);
  });

  it.each(glyphs)(
    '%s: the art covers the share of the box the terminal icon covers',
    (_id, extent) => {
      expect(Math.abs(share(extent) - REFERENCE)).toBeLessThanOrEqual(
        TOLERANCE
      );
    }
  );

  it.each(glyphs)(
    '%s: the art is centred in the box',
    (_id, { viewBox, art }) => {
      for (const axis of [0, 1]) {
        const offset =
          art[axis] +
          art[axis + 2] / 2 -
          (viewBox[axis] + viewBox[axis + 2] / 2);
        expect(Math.abs(offset) / viewBox[2]).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  );
});
