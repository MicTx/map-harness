---
description: "Construct map styles in local tools and render resolved styles, legends, linked selections, and time controls in the browser."
kind: "package-library"
---

# @map-harness/spatial-viz

English | [中文](README.zh.md)

## Summary

Use resolved styles to keep the map, legend, chart, and table on the same style/data/time revision. Local tools construct classification breaks, aggregate geographic data, and select visualization methods through the package root. Browser views use the separate `/browser` entry to display those results and manage selection and playback.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Local tool implementations import `@map-harness/spatial-viz`. Browser views and shared layer-presentation helpers import `@map-harness/spatial-viz/browser`:

```text
import { classifyValue, legendOf } from '@map-harness/spatial-viz/browser'

const classIndex = classifyValue(style, value)
const legend = legendOf(style)
```

The caller supplies a validated `StyleSpec` with fixed breaks and domain. Per-value display keeps explicit missing, underflow, and overflow classes; it does not construct a classification. The browser entry also supplies the time-axis, linked selection/table/histogram, and view-manifest functions used by the map workbench. Exact signatures and types are owned by [the browser entry](src/browser.ts).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host and browser entries share data contracts and display derivations. [Display helpers](src/display.ts) apply an already resolved style; [linked views](src/linked.ts) derive selections and export metadata from that style. The browser runtime graph contains only these helpers, contracts, and the time-axis implementation. Classification-break construction, aggregation, scanning, profiling, and method routing belong to the host entry.

The build emits `lib/index.js` and `lib/browser.js` independently, so a browser consumer does not load the host computation entry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Visualization workbench](../docs/spatial-viz.md) describes the consuming tools and map surfaces.
- [Host entry](src/index.ts) owns the complete computation API.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through visualization tools that serialize computed results and presentation metadata.

#### KV Cache effect

The library does not assemble model requests or edit request history. The calling tools own the text and metadata they publish.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser display and interaction code is delivered to the browser; the local application owns protection of core computation code.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
