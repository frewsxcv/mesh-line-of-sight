#![allow(static_mut_refs)]

use std::f64::consts::PI;

const R_EARTH: f64 = 6_371_000.0;
const EQ_CIRC: f64 = 2.0 * PI * 6_378_137.0;
const TILE: f64 = 256.0;
const MAX_SAMPLES: usize = 8192;
const HDR: usize = 16;
const STRIDE: usize = 4;
const CLUTTER_GUARD_M: f64 = 50.0;
const UNSET_MARGIN: f32 = -1.0e30;
const UNSET_SHORT: f32 = 1.0e30;
const RING: usize = 64;
const WINDOW: usize = 32;

#[derive(Default)]
struct State {
    w: usize,
    h: usize,
    zoom: u32,
    ox: f64,
    oy: f64,
    dem: Vec<f32>,
    best_margin: Vec<f32>,
    best_short: Vec<f32>,
    count: Vec<u8>,
    s_margin: Vec<f32>,
    s_short: Vec<f32>,
    rgba: Vec<u8>,
    shade: Vec<u8>,
    out: Vec<f32>,
}

static mut STATE: Option<State> = None;

fn st() -> &'static mut State {
    unsafe { STATE.get_or_insert_with(State::default) }
}

struct Ray {
    u0: f64,
    v0: f64,
    mpp: f64,
    htx: f64,
    hrx: f64,
    radius: f64,
    ke: f64,
    lambda: f64,
    clutter: f64,
    budget: f64,
    fspl_c: f64,
}

fn knife_edge_loss(v: f64) -> f64 {
    if v <= -0.78 {
        0.0
    } else {
        6.9 + 20.0 * (((v - 0.1).powi(2) + 1.0).sqrt() + v - 0.1).log10()
    }
}

impl State {
    fn world_px(&self) -> f64 {
        TILE * f64::from(1u32 << self.zoom)
    }

    fn meters_per_px(&self, gy: f64) -> f64 {
        let n = self.world_px();
        let lat = (PI * (1.0 - 2.0 * gy / n)).sinh().atan();
        EQ_CIRC * lat.cos() / n
    }

    fn local(&self, gx: f64, gy: f64) -> (f64, f64) {
        (gx - self.ox - 0.5, gy - self.oy - 0.5)
    }

    fn inside(&self, u: f64, v: f64) -> bool {
        u >= -0.5 && v >= -0.5 && u < self.w as f64 - 0.5 && v < self.h as f64 - 0.5
    }

    fn sample(&self, u: f64, v: f64) -> f64 {
        let maxx = (self.w - 1) as f64;
        let maxy = (self.h - 1) as f64;
        let u = u.clamp(0.0, maxx);
        let v = v.clamp(0.0, maxy);
        let x0 = u.floor() as usize;
        let y0 = v.floor() as usize;
        let x1 = (x0 + 1).min(self.w - 1);
        let y1 = (y0 + 1).min(self.h - 1);
        let fx = u - x0 as f64;
        let fy = v - y0 as f64;
        let row0 = y0 * self.w;
        let row1 = y1 * self.w;
        let a = self.dem[row0 + x0] as f64;
        let b = self.dem[row0 + x1] as f64;
        let c = self.dem[row1 + x0] as f64;
        let d = self.dem[row1 + x1] as f64;
        let top = a + (b - a) * fx;
        let bot = c + (d - c) * fx;
        top + (bot - top) * fy
    }

    fn ensure_cov(&mut self) {
        let n = self.w * self.h;
        if self.best_margin.len() != n {
            self.best_margin = vec![UNSET_MARGIN; n];
            self.best_short = vec![UNSET_SHORT; n];
            self.count = vec![0; n];
            self.s_margin = vec![UNSET_MARGIN; n];
            self.s_short = vec![UNSET_SHORT; n];
            self.rgba = vec![0; n * 4];
        }
    }

    fn cast_ray(&mut self, p: &Ray, dx: f64, dy: f64, l: f64) {
        let step_px = (dx * dx + dy * dy).sqrt() / l;
        let step_m = step_px * p.mpp;
        let delay = ((CLUTTER_GUARD_M / step_m).ceil() as usize).clamp(1, RING / 2);
        let mut ring = [(f64::NEG_INFINITY, 0.0f64, 0.0f64); RING];
        let mut hist = [(0.0f64, 0.0f64, 0.0f64); WINDOW];
        let mut smax_t = f64::NEG_INFINITY;
        let (mut d_t, mut e_t) = (0.0, 0.0);
        let mut smax_c = f64::NEG_INFINITY;
        let (mut d_c, mut e_c) = (0.0, 0.0);
        let steps = l as usize;

        for i in 1..=steps {
            let f = i as f64 / l;
            let u = p.u0 + dx * f;
            let v = p.v0 + dy * f;
            if !self.inside(u, v) {
                break;
            }
            let d = i as f64 * step_m;
            if d > p.radius {
                break;
            }
            if p.clutter > 0.0 && i > delay {
                let (sl, dd, ee) = ring[(i - delay) % RING];
                if sl > smax_c {
                    smax_c = sl;
                    d_c = dd;
                    e_c = ee;
                }
            }

            let ground = self.sample(u, v) - d * d / (2.0 * p.ke);
            let rx_top = ground + p.hrx;
            let str_ = (rx_top - p.htx) / d;
            let (stim, d1, e1) = if smax_c > smax_t {
                (smax_c, d_c, e_c)
            } else {
                (smax_t, d_t, e_t)
            };

            let (short, loss) = if stim.is_finite() {
                let back = (i - 1).min(WINDOW);
                let obstacle = |k: usize| -> (f64, f64) {
                    if k == back {
                        return (d1, e1);
                    }
                    let (dk, gk, ck) = hist[(i - 1 - k) % WINDOW];
                    (dk, if d - dk > CLUTTER_GUARD_M { ck } else { gk })
                };
                let luc = if stim < str_ {
                    let mut vmax = f64::NEG_INFINITY;
                    for k in 0..=back {
                        let (dk, ek) = obstacle(k);
                        let d2 = d - dk;
                        if dk <= 0.0 || d2 <= 0.0 {
                            continue;
                        }
                        let y = (p.htx * d2 + rx_top * dk) / d;
                        vmax = vmax.max((ek - y) * (2.0 * d / (p.lambda * dk * d2)).sqrt());
                    }
                    knife_edge_loss(vmax)
                } else {
                    let mut srim = f64::NEG_INFINITY;
                    for k in 0..=back {
                        let (dk, ek) = obstacle(k);
                        if d - dk > 0.0 {
                            srim = srim.max((ek - rx_top) / (d - dk));
                        }
                    }
                    let dbp = ((rx_top - p.htx + srim * d) / (stim + srim)).clamp(1e-3, d - 1e-3);
                    let y = (p.htx * (d - dbp) + rx_top * dbp) / d;
                    let vb = (p.htx + stim * dbp - y) * (2.0 * d / (p.lambda * dbp * (d - dbp))).sqrt();
                    knife_edge_loss(vb)
                };
                ((stim - str_) * d, bullington_corrected(luc, d))
            } else {
                (-1.0e3, 0.0)
            };
            let margin = p.budget - (20.0 * d.log10() + p.fspl_c) - loss;

            let idx = ((v + 0.5) as usize) * self.w + (u + 0.5) as usize;
            let m = margin as f32;
            if m > self.s_margin[idx] {
                self.s_margin[idx] = m;
            }
            let s = short as f32;
            if s < self.s_short[idx] {
                self.s_short[idx] = s;
            }

            let sl_t = (ground - p.htx) / d;
            if sl_t > smax_t {
                smax_t = sl_t;
                d_t = d;
                e_t = ground;
            }
            let top = ground + p.clutter;
            if p.clutter > 0.0 {
                ring[i % RING] = ((top - p.htx) / d, d, top);
            }
            hist[i % WINDOW] = (d, ground, top);
        }
    }
}

#[no_mangle]
pub extern "C" fn dem_init(w: usize, h: usize, zoom: u32, ox: f64, oy: f64) -> *mut f32 {
    let s = st();
    s.w = w;
    s.h = h;
    s.zoom = zoom;
    s.ox = ox;
    s.oy = oy;
    s.best_margin = Vec::new();
    s.best_short = Vec::new();
    s.count = Vec::new();
    s.s_margin = Vec::new();
    s.s_short = Vec::new();
    s.rgba = Vec::new();
    s.shade = Vec::new();
    s.dem = vec![0.0; w * h];
    s.dem.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn elev_at(gx: f64, gy: f64) -> f64 {
    let s = st();
    let (u, v) = s.local(gx, gy);
    if s.dem.is_empty() || !s.inside(u, v) {
        return f64::NAN;
    }
    s.sample(u, v)
}

fn bullington_corrected(luc: f64, dist_m: f64) -> f64 {
    luc + (1.0 - (-luc / 6.0).exp()) * (10.0 + 0.02 * dist_m / 1000.0)
}

fn bullington(d: &[f64], t: &[f64], h0: f64, h1: f64, lambda: f64) -> f64 {
    let n = d.len();
    let dist = d[n - 1];
    let str_ = (h1 - h0) / dist;
    let mut stim = f64::NEG_INFINITY;
    for i in 1..n - 1 {
        stim = stim.max((t[i] - h0) / d[i]);
    }
    let luc = if stim < str_ {
        let mut vmax = f64::NEG_INFINITY;
        for i in 1..n - 1 {
            let d2 = dist - d[i];
            let y = (h0 * d2 + h1 * d[i]) / dist;
            vmax = vmax.max((t[i] - y) * (2.0 * dist / (lambda * d[i] * d2)).sqrt());
        }
        knife_edge_loss(vmax)
    } else {
        let mut srim = f64::NEG_INFINITY;
        for i in 1..n - 1 {
            srim = srim.max((t[i] - h1) / (dist - d[i]));
        }
        let dbp = ((h1 - h0 + srim * dist) / (stim + srim)).clamp(1e-3, dist - 1e-3);
        let y = (h0 * (dist - dbp) + h1 * dbp) / dist;
        let vb = (h0 + stim * dbp - y) * (2.0 * dist / (lambda * dbp * (dist - dbp))).sqrt();
        knife_edge_loss(vb)
    };
    bullington_corrected(luc, dist)
}

#[no_mangle]
pub extern "C" fn link_analyze(
    ax: f64,
    ay: f64,
    ha: f64,
    bx: f64,
    by: f64,
    hb: f64,
    freq_mhz: f64,
    k: f64,
    clutter: f64,
) -> *const f32 {
    let s = st();
    if s.out.len() < HDR + STRIDE * MAX_SAMPLES {
        s.out = vec![0.0; HDR + STRIDE * MAX_SAMPLES];
    }
    if s.dem.is_empty() {
        s.out[0] = 0.0;
        return s.out.as_ptr();
    }
    let (au, av) = s.local(ax, ay);
    let (bu, bv) = s.local(bx, by);
    let dpx = ((bu - au).powi(2) + (bv - av).powi(2)).sqrt();
    let mpp = s.meters_per_px((ay + by) / 2.0);
    let dist = (dpx * mpp).max(1.0);
    let n = ((dpx * 2.0).ceil() as usize + 1).clamp(64, MAX_SAMPLES);
    let lambda = 299.792458 / freq_mhz;
    let ke = k * R_EARTH;

    let mut dd = vec![0.0f64; n];
    let mut tt = vec![0.0f64; n];
    let mut ee = vec![0.0f64; n];
    for i in 0..n {
        let f = i as f64 / (n - 1) as f64;
        let e = s.sample(au + (bu - au) * f, av + (bv - av) * f);
        let di = f * dist;
        let bulge = di * (dist - di) / (2.0 * ke);
        let clut = if di > CLUTTER_GUARD_M && dist - di > CLUTTER_GUARD_M { clutter } else { 0.0 };
        dd[i] = di;
        ee[i] = e;
        tt[i] = e + bulge + clut;
        let o = HDR + i * STRIDE;
        s.out[o] = di as f32;
        s.out[o + 1] = e as f32;
        s.out[o + 2] = bulge as f32;
        s.out[o + 3] = clut as f32;
    }
    let h0 = ee[0] + ha;
    let h1 = ee[n - 1] + hb;

    let mut min_clear = f64::INFINITY;
    let mut min_ratio = f64::INFINITY;
    let mut worst = 0usize;
    for i in 1..(n - 1) {
        let y = h0 + (h1 - h0) * dd[i] / dist;
        let c = y - tt[i];
        let f1 = (lambda * dd[i] * (dist - dd[i]) / dist).sqrt();
        if c < min_clear {
            min_clear = c;
        }
        let r = if f1 > 0.0 { c / f1 } else { f64::INFINITY };
        if r < min_ratio {
            min_ratio = r;
            worst = i;
        }
    }
    let diff = bullington(&dd, &tt, h0, h1, lambda);
    let fspl = 20.0 * dist.log10() + 20.0 * freq_mhz.log10() - 27.55;

    let hdr = [
        n as f64, dist, ee[0], ee[n - 1], min_clear, min_ratio, worst as f64, diff, fspl, lambda, h0, h1,
    ];
    for (i, v) in hdr.iter().enumerate() {
        s.out[i] = *v as f32;
    }
    s.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn coverage_reset() {
    let s = st();
    if s.dem.is_empty() {
        return;
    }
    s.ensure_cov();
    s.best_margin.fill(UNSET_MARGIN);
    s.best_short.fill(UNSET_SHORT);
    s.count.fill(0);
}

#[no_mangle]
pub extern "C" fn coverage_add(
    gx: f64,
    gy: f64,
    htx: f64,
    hrx: f64,
    radius_m: f64,
    freq_mhz: f64,
    k: f64,
    clutter: f64,
    eirp_dbm: f64,
    rx_gain_db: f64,
    sens_dbm: f64,
) -> i32 {
    let s = st();
    if s.dem.is_empty() {
        return 0;
    }
    s.ensure_cov();
    let (u0, v0) = s.local(gx, gy);
    if !s.inside(u0, v0) {
        return 0;
    }
    let mpp = s.meters_per_px(gy);
    let r_px = radius_m / mpp;
    let p = Ray {
        u0,
        v0,
        mpp,
        htx: s.sample(u0, v0) + htx,
        hrx,
        radius: radius_m,
        ke: k * R_EARTH,
        lambda: 299.792458 / freq_mhz,
        clutter,
        budget: eirp_dbm + rx_gain_db - sens_dbm,
        fspl_c: 20.0 * freq_mhz.log10() - 27.55,
    };

    let x0 = (u0 - r_px).floor().max(0.0) as usize;
    let y0 = (v0 - r_px).floor().max(0.0) as usize;
    let x1 = ((u0 + r_px).ceil() as usize).min(s.w - 1);
    let y1 = ((v0 + r_px).ceil() as usize).min(s.h - 1);
    for y in y0..=y1 {
        let row = y * s.w;
        s.s_margin[row + x0..=row + x1].fill(UNSET_MARGIN);
        s.s_short[row + x0..=row + x1].fill(UNSET_SHORT);
    }

    let l = r_px.ceil().max(1.0) as i64;
    let lf = l as f64;
    for t in -l..l {
        let tf = t as f64;
        s.cast_ray(&p, tf, -lf, lf);
        s.cast_ray(&p, lf, tf, lf);
        s.cast_ray(&p, -tf, lf, lf);
        s.cast_ray(&p, -lf, -tf, lf);
    }

    let tx_idx = ((v0 + 0.5) as usize) * s.w + (u0 + 0.5) as usize;
    s.s_short[tx_idx] = -1.0e3;
    if s.s_margin[tx_idx] == UNSET_MARGIN {
        s.s_margin[tx_idx] = p.budget as f32;
    }

    for y in y0..=y1 {
        let row = y * s.w;
        for x in x0..=x1 {
            let i = row + x;
            let m = s.s_margin[i];
            if m == UNSET_MARGIN {
                continue;
            }
            if m > s.best_margin[i] {
                s.best_margin[i] = m;
            }
            if s.s_short[i] < s.best_short[i] {
                s.best_short[i] = s.s_short[i];
            }
            if m >= 0.0 {
                s.count[i] = s.count[i].saturating_add(1);
            }
        }
    }
    1
}

fn put(px: &mut [u8], c: [u8; 4]) {
    px.copy_from_slice(&c);
}

#[no_mangle]
pub extern "C" fn coverage_rgba(mode: u32) -> *const u8 {
    let s = st();
    if s.dem.is_empty() {
        return std::ptr::null();
    }
    s.ensure_cov();
    let n = s.w * s.h;
    for i in 0..n {
        let px = &mut s.rgba[i * 4..i * 4 + 4];
        let short = s.best_short[i];
        if short == UNSET_SHORT {
            put(px, [0, 0, 0, 0]);
            continue;
        }
        let c = match mode {
            1 => {
                if short <= 0.0 {
                    [22, 163, 74, 170]
                } else if short <= 5.0 {
                    [234, 179, 8, 150]
                } else if short <= 20.0 {
                    [234, 88, 12, 90]
                } else {
                    [0, 0, 0, 0]
                }
            }
            2 => match s.count[i] {
                0 => [0, 0, 0, 0],
                1 => [96, 165, 250, 130],
                2 => [37, 99, 235, 160],
                _ => [30, 27, 160, 185],
            },
            _ => {
                let m = s.best_margin[i];
                if m >= 20.0 {
                    [21, 128, 61, 175]
                } else if m >= 10.0 {
                    [74, 194, 84, 160]
                } else if m >= 0.0 {
                    [234, 179, 8, 150]
                } else if m >= -10.0 {
                    [234, 88, 12, 85]
                } else {
                    [0, 0, 0, 0]
                }
            }
        };
        put(px, c);
    }
    s.rgba.as_ptr()
}

const RELIEF_STOPS: [(f64, [f64; 3]); 5] = [
    (0.0, [74.0, 135.0, 84.0]),
    (0.3, [158.0, 186.0, 108.0]),
    (0.55, [224.0, 204.0, 140.0]),
    (0.8, [168.0, 122.0, 84.0]),
    (1.0, [246.0, 244.0, 238.0]),
];

fn relief_color(t: f64) -> [f64; 3] {
    let t = t.clamp(0.0, 1.0);
    for w in RELIEF_STOPS.windows(2) {
        let (t0, c0) = w[0];
        let (t1, c1) = w[1];
        if t <= t1 {
            let f = (t - t0) / (t1 - t0);
            return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
        }
    }
    RELIEF_STOPS[RELIEF_STOPS.len() - 1].1
}

fn elevation_range(dem: &[f32]) -> (f64, f64) {
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for &e in dem {
        if e > 0.0 {
            lo = lo.min(e);
            hi = hi.max(e);
        }
    }
    if !lo.is_finite() || hi - lo < 1.0 {
        return (0.0, 1.0);
    }
    const BINS: usize = 1024;
    let mut hist = [0usize; BINS];
    let scale = (BINS - 1) as f32 / (hi - lo);
    let mut n = 0usize;
    for &e in dem {
        if e > 0.0 {
            hist[((e - lo) * scale) as usize] += 1;
            n += 1;
        }
    }
    let pick = |q: f64| -> f64 {
        let target = (n as f64 * q) as usize;
        let mut acc = 0usize;
        for (i, c) in hist.iter().enumerate() {
            acc += c;
            if acc > target {
                return lo as f64 + i as f64 / scale as f64;
            }
        }
        hi as f64
    };
    let (a, b) = (pick(0.01), pick(0.99));
    if b - a < 1.0 {
        (lo as f64, hi as f64)
    } else {
        (a, b)
    }
}

#[no_mangle]
pub extern "C" fn terrain_rgba(mode: u32, azimuth_deg: f64, altitude_deg: f64, exaggeration: f64) -> *const u8 {
    let s = st();
    if s.dem.is_empty() {
        return std::ptr::null();
    }
    let (w, h) = (s.w, s.h);
    if s.shade.len() != w * h * 4 {
        s.shade = vec![0; w * h * 4];
    }
    let zenith = (90.0 - altitude_deg).to_radians();
    let azimuth = (360.0 - azimuth_deg + 90.0).rem_euclid(360.0).to_radians();
    let flat = zenith.cos();
    let (lo, hi) = elevation_range(&s.dem);
    let at = |x: usize, y: usize| s.dem[y * w + x] as f64;

    for y in 0..h {
        let cell = s.meters_per_px(s.oy + y as f64 + 0.5);
        let ym = y.saturating_sub(1);
        let yp = (y + 1).min(h - 1);
        for x in 0..w {
            let xm = x.saturating_sub(1);
            let xp = (x + 1).min(w - 1);
            let (a, b, c) = (at(xm, ym), at(x, ym), at(xp, ym));
            let (d, f) = (at(xm, y), at(xp, y));
            let (g, hh, i) = (at(xm, yp), at(x, yp), at(xp, yp));
            let dzdx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * cell);
            let dzdy = ((g + 2.0 * hh + i) - (a + 2.0 * b + c)) / (8.0 * cell);
            let slope = (exaggeration * (dzdx * dzdx + dzdy * dzdy).sqrt()).atan();
            let aspect = dzdy.atan2(-dzdx);
            let hs = (zenith.cos() * slope.cos() + zenith.sin() * slope.sin() * (azimuth - aspect).cos()).max(0.0);

            let e = at(x, y);
            let o = (y * w + x) * 4;
            let px: [u8; 4] = if mode == 1 {
                if e <= 0.0 {
                    [168, 200, 228, 255]
                } else {
                    let base = relief_color((e - lo) / (hi - lo));
                    let k = (hs / flat).clamp(0.35, 1.3);
                    [
                        (base[0] * k).min(255.0) as u8,
                        (base[1] * k).min(255.0) as u8,
                        (base[2] * k).min(255.0) as u8,
                        255,
                    ]
                }
            } else if hs < flat {
                [0, 0, 0, (255.0 * ((flat - hs) / flat).min(1.0)) as u8]
            } else {
                [255, 255, 255, (150.0 * ((hs - flat) / (1.0 - flat)).min(1.0)) as u8]
            };
            s.shade[o..o + 4].copy_from_slice(&px);
        }
    }
    s.shade.as_ptr()
}
