---
kind: upgrade-guide
description: "Enabling fixed early imagery can automatically blend the recent imagery layer at 50% opacity."
---

# Enabling early imagery blends an opaque recent layer

English | [中文](guide.zh.md)

## Change

Selecting or reopening early imagery in the map panel now changes visible recent imagery from 100% to 50% opacity. `map_set_imagery` applies the same blend when `early_visible: true` omits both `recent_visible` and `recent_opacity`; explicit settings take precedence. Selecting `early_release_id` alone still leaves early visibility unchanged. Existing Session data and its format remain unchanged.

## Migration

1. If a `map_set_imagery` caller requires a fully opaque recent layer when showing early imagery, pass `recent_opacity: 1` or an explicit `recent_visible` value in that call.
2. In the map panel, adjust the recent imagery opacity after selecting or reopening early imagery if a different blend is needed. Use `map_get_state` or the panel's recent imagery row to confirm the resulting opacity.
