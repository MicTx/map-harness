/**
 * Dictionary entries for the map container, layer, collaboration, and
 * vector-geometry tool families.
 * @module @map-harness/map-container/tool-cards/dictionary-map
 */
import { field, entry, layerArg, nameArg, pathArg, refArg, refResult, statusResult, type PresentationEntry } from './entry.ts'
import { bboxOf, countOf, decimal, enumOf, idOf, lengthOf, lonLatOf, metersOf, millisOf, numberOf, squareMetersOf, textOf, yesNoOf } from './format.ts'

const zoomOf = (value: unknown): string | undefined => {
  const z = numberOf(value)
  return z === undefined ? undefined : `${decimal(z, 1)} 级`
}
const MODE_LABELS = { '2d': '二维地图', '3d': '三维场景', map: '二维地图', scene: '三维场景' }
const DRAW_LABELS = { point: '点', line: '线', polygon: '面', LineString: '线', Polygon: '面', Point: '点' }
const featureCount = (key: string) => field('要素数', key, v => countOf(v, '个'))
const layerTotal = field('当前图层数', 'total_layers', v => countOf(v, '个'))
const revisionArg = field('期望版本', 'expected_revision', idOf)
const pairArgs = (noun: string) => [
  pathArg('path_a', `${noun} A`), refArg('ref_a', `${noun} A`),
  pathArg('path_b', `${noun} B`), refArg('ref_b', `${noun} B`),
]

/** Map, layer, collaboration, and geometry entries. */
export const MAP_ENTRIES = {
  map_add_layer: entry('添加图层', 'edit',
    [nameArg(), layerArg(), pathArg(), refArg(), field('瓦片服务', 'tile_url', textOf), field('坐标系', 'crs', textOf)],
    [field('图层', 'layer.name', textOf), featureCount('layer.featureCount'), field('范围', 'bbox', bboxOf), layerTotal]),
  map_draw: entry('绘制要素', 'edit',
    [nameArg('label', '标注'), nameArg(), field('类型', 'kind', v => enumOf(v, DRAW_LABELS)), layerArg(), field('顶点数', 'coordinates', v => lengthOf(v, '个'))],
    [field('图层', 'layer.name', textOf), field('范围', 'bbox', bboxOf), layerTotal]),
  map_remove_layer: entry('移除图层', 'delete', [layerArg()],
    [field('已移除', 'removed', yesNoOf), layerTotal]),
  map_set_view: entry('移动视图', 'edit',
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf), field('投影', 'wkid', idOf)],
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf)]),
  map_fit_view: entry('缩放到范围', 'edit',
    [layerArg(), field('范围', 'bbox', bboxOf), field('留白', 'padding', v => countOf(v, '像素'))],
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf)]),
  map_set_mode: entry('切换显示模式', 'edit', [field('模式', 'mode', v => enumOf(v, MODE_LABELS))]),
  map_get_state: entry('读取地图状态', 'read', [],
    [field('地图版本', 'revision', idOf), field('图层数', 'layers', v => lengthOf(v, '个')), field('模式', 'mode', v => enumOf(v, MODE_LABELS))]),
  map_locate: entry('定位地点', 'search', [field('地点', 'query', textOf), field('范围', 'bbox', bboxOf)],
    [field('找到', 'found', yesNoOf), field('候选', 'candidates', v => lengthOf(v, '个')), field('来源', 'provider', textOf)]),
  map_observe: entry('观察地图画面', 'read', [field('等待上限', 'timeout_ms', millisOf)]),
  map_apply_patch: entry('协同编辑地图', 'edit', [field('操作', 'operation_id', idOf), revisionArg]),
  map_undo: entry('撤销协同操作', 'edit', [field('撤销对象', 'undo_of', idOf), revisionArg]),
  map_save: entry('保存地图', 'edit', [field('地图版本', 'map_revision', idOf)],
    [field('已保存', 'saved', yesNoOf), field('版本', 'revision', idOf)]),
  layer_set_state: entry('调整图层状态', 'edit', [field('图层', 'states', v => lengthOf(v, '个'))],
    [field('已更新', 'updated', v => Array.isArray(v) ? countOf(v.length, '个图层') : countOf(v, '个图层'))]),
  layer_set_style: entry('设置图层样式', 'edit', [layerArg(), field('预设', 'preset', textOf), field('自动配色', 'auto', yesNoOf)],
    [field('图层', 'layer.name', textOf)]),
  geo_buffer: entry('缓冲区分析', 'execute', [pathArg(), refArg('ref', '数据'), field('距离', 'distance_m', metersOf)],
    [field('距离', 'distance_m', metersOf), field('面积', 'area_m2', squareMetersOf), refResult('resource_ref'), statusResult]),
  geo_area: entry('计算面积', 'execute', [pathArg(), refArg('ref', '数据'), field('要素序号', 'feature_index', idOf)],
    [field('面积', 'area_m2', squareMetersOf), statusResult]),
  geo_perimeter: entry('计算周长', 'execute', [pathArg(), refArg('ref', '数据')],
    [field('周长', 'perimeter_m', metersOf), statusResult]),
  geo_intersect: entry('相交分析', 'execute', pairArgs('图形'),
    [field('相交', 'intersects', yesNoOf), field('面积', 'area_m2', squareMetersOf), statusResult]),
  geo_union: entry('合并图形', 'execute', pairArgs('图形'), [field('面积', 'area_m2', squareMetersOf), statusResult]),
  geo_difference: entry('图形求差', 'execute', pairArgs('图形'), [field('面积', 'area_m2', squareMetersOf), statusResult]),
  geo_distance: entry('测量距离', 'execute', pairArgs('对象'), [field('距离', 'distance_m', metersOf), statusResult]),
  geo_point_line_distance: entry('点到线距离', 'execute',
    [pathArg('point_path', '点'), refArg('point_ref', '点'), pathArg('line_path', '线'), refArg('line_ref', '线')],
    [field('距离', 'distance_m', metersOf), field('最近点', 'nearest_point', lonLatOf), statusResult]),
  geo_nearest: entry('最近设施', 'execute',
    [pathArg('point_path', '起点'), refArg('point_ref', '起点'), pathArg('facilities_path', '设施')],
    [field('最近距离', 'nearest_distance_m', metersOf), field('设施序号', 'facility_feature_index', idOf), field('候选', 'candidates', v => lengthOf(v, '个')), statusResult]),
  geo_contour: entry('生成等值线', 'execute', [pathArg(), refArg('ref', '数据'), field('字段', 'field', textOf), field('分级', 'breaks', v => lengthOf(v, '级'))],
    [field('等值线', 'isoline_count', v => countOf(v, '条')), statusResult]),
} satisfies Record<string, PresentationEntry>
