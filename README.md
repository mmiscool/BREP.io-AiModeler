# Plugin Development Guide

This document explains how to build third‑party plugins for the BREP CAD application. It covers the plugin entrypoint, the `app` object you receive (including `app.BREP`), how to register new features, the structure of a feature class, the supported parameter schema types, and the small UI hooks you can use.

If you just want the TL;DR: your repo must contain a `plugin.js` ES module that exports a function. In that function, call `app.registerFeature(YourFeatureClass)` and optionally add UI via `app.addToolbarButton(...)` or `app.addSidePanel(...)`.


You can fork this repo as a starting point for your plugin. After you have forked it simply edit `plugin.js`.

See also: the BREP application README: https://github.com/mmiscool/BREP/blob/master/README.md

## Overview

- Plugins are ES modules fetched directly from GitHub.
- The loader expects an entry file named `plugin.js` in the repo (or subdirectory when the URL includes it).
- The entry is executed with a single argument: `app`, an object that provides:
  - `BREP`: access to BREP modeling classes/utilities (solids/primitives/CSG helpers/THREE instance).
  - `viewer`: the live viewer instance (scene, part history, toolbar, etc.).
  - `registerFeature(FeatureClass)`: register a new modeling feature.
  - `addToolbarButton(label, title, onClick)`: add a toolbar button.
  - `addSidePanel(title, content)`: add a side panel section to the sidebar.

Where these come from in the app: see [src/plugins/pluginManager.js](https://github.com/mmiscool/BREP/blob/master/src/plugins/pluginManager.js) (builds the `app` object) and [src/UI/viewer.js](https://github.com/mmiscool/BREP/blob/master/src/UI/viewer.js) (viewer API).


## How Plugins Are Loaded

- Add your GitHub repo URL in the in‑app Plugins panel. Supported forms:
  - `https://github.com/USER/REPO`
  - `https://github.com/USER/REPO/tree/BRANCH`
  - `https://github.com/USER/REPO/tree/BRANCH/sub/dir`
- The loader looks for `plugin.js` at that path, tries GitHub Raw on `ref` (or `main`/`master`), and falls back to jsDelivr CDN.
- Relative imports inside `plugin.js` are rewritten to absolute URLs against your repo base, so you can structure your plugin across multiple files.
- Bare specifiers (e.g., `import x from 'some-npm-package'`) are NOT resolved. Use relative imports within your repo, or explicit URL imports if you need an external dependency.


## Entrypoint Contract

Place a `plugin.js` at the repo path. Export either a default function or an `install` function. Both receive `app`.

Example minimal entrypoint (from this repo):

```js
// plugin.js
import { PrimitiveSphereFeaturePlugin } from './exampleFeature.js';

export default function install(app) {
  // Make the app (and BREP) available to the feature class
  PrimitiveSphereFeaturePlugin.setup(app);

  // Optional: small UI hooks
  app.addToolbarButton('🧩', 'Hello', () => {
    console.log('Hello from plugin');
    console.log('This is the context passed in to the plugin.', app);
    alert('Yay');
  });

  app.addSidePanel('Plugin Panel', () => {
    const div = document.createElement('div');
    div.textContent = 'This was added by a plugin.';
    return div;
  });

  // Register your feature so users can add it
  app.registerFeature(PrimitiveSphereFeaturePlugin);
}
```


## The `app` Object

`app` is constructed by the application when your plugin loads:

- `app.BREP` — The modeling toolkit and a shared THREE instance. This includes:
  - `THREE`, `Solid`, `Face`, `Edge`, `Vertex`
  - primitives: `Cube`, `Sphere`, `Cylinder`, `Cone`, `Torus`, `Pyramid`
  - operations: `Sweep`, `ExtrudeSolid`, `ChamferSolid`, `FilletSolid`
  - utilities: `applyBooleanOperation(partHistory, baseSolid, booleanParam, featureID)`, `MeshToBrep`, `MeshRepairer`
- `app.viewer` — The live viewer. Useful bits:
  - `viewer.scene` — A Three.js scene containing the model objects.
  - `viewer.partHistory` — The history and feature pipeline (see below).
  - `viewer.addToolbarButton(label, title, onClick)` — Add a custom button.
  - `viewer.addPluginSidePanel(title, content)` — Add a side panel; `content` can be an element, a function that returns an element, or a string.
- `app.registerFeature(FeatureClass)` — Register a feature so users can add it from the UI/history. The app marks it as plugin‑provided and prefixes names with a plug icon.


## Registering a Feature

Call `app.registerFeature(YourFeatureClass)`. The app will:
- Flag the class as plugin‑provided (`fromPlugin = true`).
- Prefix `featureShortName` and `featureName` with a plug icon in UI.
- Make it available to the Feature Registry so it can be created via the History UI or programmatically with `viewer.partHistory.newFeature('Your Name or ShortName')`.


## Feature Class Anatomy

Every feature is a small class with three static fields and two instance fields, plus a `run()` method.

- Static fields:
  - `featureShortName` — Short code shown in menus (e.g., `E`, `P.CU`).
  - `featureName` — Human friendly name.
  - `inputParamsSchema` — Describes inputs; the UI is auto‑generated from this.
- Instance fields:
  - `this.inputParams` — Filled with sanitized values before `run()` is called.
  - `this.persistentData` — Your scratchpad; survives across runs of this feature.
- Method:
  - `async run(partHistory)` — Build/update geometry. Return either:
    - An array of objects to add to the scene, OR
    - `{ added: [...], removed: [...] }` for fine‑grained control.

Typical flow inside `run()` for geometry‑creating features:
1) Construct a BREP solid/face using `app.BREP` classes.
2) Apply any transform (`bakeTRS`) and call `visualize()` to create display geometry and helper edges.
3) Apply optional boolean with `BREP.applyBooleanOperation(partHistory, base, this.inputParams.boolean, this.inputParams.featureID)`.
4) Return the result from step 3 (additions/removals). The app removes flagged items and adds new ones.

Important conventions:
- Name your output objects with `this.inputParams.featureID` (e.g., pass `name: featureID` to constructors). This enables referencing them in later features.
- You can persist heavy intermediate data in `this.persistentData` to speed up subsequent runs.


## Parameter Schema Cookbook

Define `static inputParamsSchema = { ... }`. The app uses this to:
- Provide default values when the feature is created.
- Render an editable UI.
- Sanitize/resolve values before calling `run()`.

Supported field types and options:

- `string`
  - `default_value: string`
  - `hint?: string`

- `number`
  - `default_value: number | string` — Users can type math expressions. Numbers are evaluated against the global Expressions manager, so `x * 2` is allowed if `x` is defined.
  - `min?`, `max?`, `step?`: number or string
  - `hint?: string`

- `boolean`
  - `default_value: boolean`

- `options`
  - `options: string[]` — Fixed list of values
  - `default_value: string`

- `button`
  - `label?: string`
  - `actionFunction?: (ctx) => void | Promise<void>` — Called on click. `ctx` includes `{ featureID, key, viewer, partHistory, feature, params, schemaDef }`.

- `file`
  - `accept?: string` — e.g., `.png,image/png`
  - Value is a Data URL string of the selected file after UI selection.

- `transform`
  - `default_value: { position: [x,y,z], rotationEuler: [rx,ry,rz], scale?: [sx,sy,sz] }`
  - UI provides interactive 3D gizmos; commit updates into `inputParams`.

- `reference_selection`
  - Lets users pick scene objects.
  - `selectionFilter: ["SOLID" | "FACE" | "EDGE" | "SKETCH" | "PLANE", ...]`
  - `multiple: boolean` — single value (string) or array of strings.
  - `default_value: string | string[] | null`
  - Before `run()`, the app resolves the names into actual objects where possible; `this.inputParams[key]` will be an array of objects for `multiple: true` or a single‑element array for single select.

- `boolean_operation`
  - Object with shape `{ operation: 'NONE'|'UNION'|'SUBTRACT'|'INTERSECT', targets: (string|object)[] }`.
  - Optional: `biasDistance`, `offsetCoplanarCap`, `offsetDistance` for advanced subtract behavior.
  - Pass directly to `BREP.applyBooleanOperation(...)` for robust, normalized handling.


## Using `app.BREP`

`app.BREP` is already imported from the application, so you must NOT import your own copy of Three.js or the BREP library. Using the shared instance avoids duplicate constructors and broken `instanceof` checks.

Common patterns:

```js
const { BREP } = app;

// Primitives
const sphere = new BREP.Sphere({ r: 5, resolution: 32, name: 'MySphere' });
sphere.visualize();

// Sweeps/Extrudes
const sweep = new BREP.Sweep({ face: someFace, distance: 10, name: 'MyExtrude' });
sweep.visualize();

// CSG helper
const result = await BREP.applyBooleanOperation(partHistory, sphere, { operation: 'UNION', targets: [otherSolid] }, 'Feat123');
// → { added: [Solid], removed: [Solid, ...] }
```


### Accessing `app.BREP` exactly

This repo’s example passes the `app` object into the feature class via a static `setup(app)` method, and the feature reads the shared BREP instance from there:

```js
// exampleFeature.js
export class PrimitiveSphereFeaturePlugin {
  static app = null;
  static setup(app) { this.app = app; }

  async run(partHistory) {
    const BREP = this.constructor.app.BREP; // shared instance from the host app
    const sphere = new BREP.Sphere({ r: 5, resolution: 32, name: 'FeatureID' });
    sphere.visualize();
    return await BREP.applyBooleanOperation(partHistory, sphere, this.inputParams.boolean, this.inputParams.featureID);
  }
}
```

Alternative patterns also work, such as capturing once at module scope (`let BREP; export default (app) => { BREP = app.BREP; }`) or destructuring on demand (`const { BREP } = app`). Always use the provided `app.BREP` rather than importing your own copy.


## Complete Example: Toolbar + Side Panel + Feature

This section shows the actual files in this repo and how the feature gets access to `app.BREP`.

```js
// plugin.js
import { PrimitiveSphereFeaturePlugin } from './exampleFeature.js';

export default (app) => {
  // Provide the app (which contains BREP) to the feature class
  PrimitiveSphereFeaturePlugin.setup(app);

  // Optional UI examples
  app.addToolbarButton('🧩', 'Hello', () => {
    console.log('Hello from plugin');
    console.log('This is the context passed in to the plugin.', app);
    alert('Yay');
  });
  app.addSidePanel('Plugin Panel', () => {
    const div = document.createElement('div');
    div.textContent = 'This was added by a plugin.';
    return div;
  });

  // Register the feature
  app.registerFeature(PrimitiveSphereFeaturePlugin);
};
```

```js
// exampleFeature.js
const inputParamsSchema = {
  featureID: { type: 'string', default_value: null, hint: 'Unique identifier for the feature' },
  radius: { type: 'number', default_value: 5, hint: 'Radius of the sphere' },
  resolution: { type: 'number', default_value: 32, hint: 'Base segment count (longitude). Latitude segments are derived from this.' },
  transform: { type: 'transform', default_value: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, hint: 'Position, rotation, and scale' },
  boolean: { type: 'boolean_operation', default_value: { targets: [], operation: 'NONE' }, hint: 'Optional boolean operation with selected solids' },
};

export class PrimitiveSphereFeaturePlugin {
  static featureShortName = 'S.p';
  static featureName = 'Primitive Sphere';
  static inputParamsSchema = inputParamsSchema;
  static app = null;

  static setup(app) { this.app = app; }

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { radius, resolution, featureID } = this.inputParams;
    const BREP = this.constructor.app.BREP; // Access BREP from the app provided during setup

    const sphere = await new BREP.Sphere({ r: radius, resolution, name: featureID });
    try {
      if (this.inputParams.transform) {
        sphere.bakeTRS(this.inputParams.transform);
      }
    } catch (_) {}
    sphere.visualize();

    return await BREP.applyBooleanOperation(partHistory || {}, sphere, this.inputParams.boolean, featureID);
  }
}
```

Note: the loader will prefix plugin‑provided names in the UI with a plug icon. To avoid confusion with built‑in features, pick a unique `featureShortName`.


## Programmatic Feature Creation

From toolbar buttons or side panels you can add features directly:

```js
const ph = app.viewer.partHistory;
// Either the long name or short name works; match your class statics.
const feature = await ph.newFeature('Primitive Sphere'); // or 'S.p'
feature.inputParams.radius = 20;
await ph.runHistory();
```

Internally, this uses the Feature Registry ([src/FeatureRegistry.js](https://github.com/mmiscool/BREP/blob/master/src/FeatureRegistry.js)) to find your class and apply default values from `inputParamsSchema`.


## Side Panels and Toolbar

- `app.addToolbarButton(label, title, onClick)` — Adds a small labeled button to the main toolbar.
- `app.addSidePanel(title, content)` — Inserts a collapsible section in the sidebar. `content` may be:
  - An `HTMLElement`
  - A function returning an `HTMLElement` (async allowed)
  - A string (rendered in a `<pre>`) 

Plugin side panels appear before the Display Settings panel.


## Recommended Repo Layout

```
your-plugin-repo/
  plugin.js            # entrypoint (required)
  exampleFeature.js    # a feature class
```

`plugin.js` can import your own files via relative paths:

```js
import { PrimitiveSphereFeaturePlugin } from './exampleFeature.js';
export default (app) => {
  PrimitiveSphereFeaturePlugin.setup(app);
  app.registerFeature(PrimitiveSphereFeaturePlugin);
};
```


## Best Practices

- Always call `.visualize()` on solids you generate before returning them.
- Name your outputs with the feature’s `featureID` for easy referencing.
- Use `this.persistentData` for caches/intermediate results to speed reruns.
- Prefer `app.BREP.THREE` over importing your own Three.js.
- Keep imports relative to your repo, or use absolute URL imports when needed.
- For boolean operations, prefer the provided helper: `BREP.applyBooleanOperation(...)`.


## Troubleshooting

- “Cannot find plugin.js” — Ensure the file exists at the path your URL points to. If you use a subdirectory, include it in the GitHub URL (see above).
- “Import failed” — Avoid bare specifiers. Use relative paths or absolute URLs.
- “TypeError or geometry not visible” — Did you call `.visualize()` on your BREP solids/faces? Are you naming outputs correctly?
- “Selections don’t resolve” — For `reference_selection` fields, the app resolves names to objects at run time. Ensure the referenced objects exist and are named.


## References (source)

- App plugin surface and loader: [src/plugins/pluginManager.js](https://github.com/mmiscool/BREP/blob/master/src/plugins/pluginManager.js)
- Feature registry and history execution: [src/FeatureRegistry.js](https://github.com/mmiscool/BREP/blob/master/src/FeatureRegistry.js), [src/PartHistory.js](https://github.com/mmiscool/BREP/blob/master/src/PartHistory.js)
- Example features (good templates): [src/features](https://github.com/mmiscool/BREP/tree/master/src/features)
- Boolean helper: [src/BREP/applyBooleanOperation.js](https://github.com/mmiscool/BREP/blob/master/src/BREP/applyBooleanOperation.js)
