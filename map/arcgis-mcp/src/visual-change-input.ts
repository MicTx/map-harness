import { MAX_VISUAL_CHANGE_CANDIDATES } from '@map-harness/map-tools'
import { z } from 'zod'

/** MCP input schema for the bounded two-image change candidate batch. */
export const mapMarkChangesInput = z.object({
  comparison_id: z.string().min(1).max(256).describe('The comparison id returned by map_compare_views.'),
  items: z.array(z.record(z.string(), z.unknown())).max(MAX_VISUAL_CHANGE_CANDIDATES)
    .describe(`An array of 0..${MAX_VISUAL_CHANGE_CANDIDATES} candidates. One candidate: kind (appeared|disappeared|modified|uncertain), category (<=512 UTF-8 bytes), note (<=512 UTF-8 bytes), confidence (uncertain|likely), and pixelGeometry as one flat object: {type:"point",point:[x,y]}, {type:"polyline",points:[[x,y],…]}, {type:"polygon",points:[[x,y],…]}, or {type:"bbox",corners:[[x,y],[x,y],[x,y],[x,y]]}. Coordinates are output-image pixels inside the map content, not longitude/latitude.`),
  limitations: z.string().max(512).optional().describe('Optional short reason when no visible change is supported; omit for normal candidates.'),
}).strict()
