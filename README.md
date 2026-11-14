# Morning Rosetta

A pure-code picture of food: a top-down latte with rosetta latte art, poured
down the center of a warm ceramic cup on a saucer, on a wooden table in
morning light. Two roasted coffee beans rest beside the saucer.

Everything is drawn by the program — there is no image file to copy. The scene
is rendered with signed distance fields (supersampled 3x and box-downscaled for
clean anti-aliasing), shaded with radial and directional gradients (soft drop
shadows, ceramic sheen, a gloss arc across the crema, foam that sits proud of
the coffee with soft under-shadows), and encoded by hand as a 1024x1024
8-bit RGB PNG (per-row adaptive filtering, zlib + CRC32).

Entered on [make.fun](https://make.fun/bounty/food-picture-01) for the
"Make the best-looking food picture" competition.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

The program writes `entry.png` into `$MAKEFUN_OUTPUT_DIR` (default `/output`,
as the grader's container uses). Node 22, standard library only, no network,
no randomness, no clock: two runs write byte-identical output.
