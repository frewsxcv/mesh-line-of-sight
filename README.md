# Mesh Line of Sight

A browser tool for planning MeshCore and Meshtastic (LoRa) nodes. Place points, set each antenna's height above ground, and see:

- **Links** between every pair of points: distance, whether terrain blocks the path, Fresnel zone clearance, diffraction loss and estimated link margin.
- **Elevation profile** for any link (click it), with earth curvature, line of sight, the first Fresnel zone and obstructions.
- **Terrain view**: hillshade or color relief drawn from the downloaded elevation data.
- **Coverage overlay**: where a handheld receiver could hear your repeaters, as estimated link margin, pure line of sight, or the number of repeaters reaching each spot.

The terrain math runs in WebAssembly (Rust, no dependencies) inside a Web Worker.

## Run

```sh
./serve.sh          # http://localhost:8000 (no-cache, so updates show on reload)
```

`web/los.wasm` is already built. To rebuild after editing `src/lib.rs` (needs `rustup target add wasm32-unknown-unknown`):

```sh
./build.sh
```

## Elevation data

**Download elevation for area** fetches [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium PNG encoding) covering all points plus the area radius. They need no API key. The sources are USGS NED (US, around 10 m), SRTM (around 30 m) and GMTED/ETOPO elsewhere. Tiles are kept in the browser's Cache Storage, so a downloaded area works offline and reloads when you reopen the page. Elevation below sea level is clamped to 0 so that water reads as a flat surface.

## Model

- Radio: pick MeshCore (the community region presets from the MeshCore app) or Meshtastic (modem preset plus region). Spreading factor, bandwidth and frequency come from the preset. TX power and antenna gain stay editable because they depend on your hardware.

- Curvature: effective earth radius with k = 4/3 by default.
- Path loss: free-space loss plus Bullington diffraction (ITU-R P.526 / P.452 form, including the P.452 multi-edge correction).
- Link margin: TX power + both antenna gains − 2 × cable loss − extra loss − path loss − receiver sensitivity.
- Sensitivity: −174 + 10·log10(BW) + 6 dB noise figure + the SNR limit for the spreading factor.
- Coverage: radial sweep from each repeater. Obstacles on the repeater's side are tracked exactly. On the receiver's side, only the last ~1 km is checked for diffraction.

The elevation data is bare terrain. Trees and buildings are missing unless you set **Clutter**. Ground reflection, foliage and noise are also not modelled, so treat the output as an optimistic upper bound. Use **Extra loss** to calibrate it against links you know work.
