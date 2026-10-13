# planetarydems.org

Source of the Planetary DEMs website, served by GitHub Pages at <https://planetarydems.org>.

Static files, no build step on the server:

| path | content |
|---|---|
| `index.html` | the MESA page |
| `contributors.html` | the authors and credits |
| `gis.js` | the "Download for GIS" tool (geotiff.js and JSZip load from CDNs when it is used) |
| `img/` | perspective views (MESA and MOLA, CTX image and shaded relief), thumbnails, figures |
| `data/` | `sites.json` (gallery) and `tables.json` (accuracy numbers) |
| `viewer/` | interactive 3-D viewer: `mesa3d.js`, three.js 0.170.0 (MIT, `viewer/vendor/`), per-site terrain in `viewer/sites/` |

Fonts load from Google Fonts. `CNAME` holds the custom domain; `.nojekyll` makes GitHub Pages serve the files as they are.

The page is generated from `mars_dem/website/prototype/` by `mars_dem/website/scripts/build_site.py`. Push to `main` to
republish; GitHub Pages updates within a few minutes.
