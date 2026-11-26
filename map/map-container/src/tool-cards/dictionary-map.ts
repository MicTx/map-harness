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
const opacityOf = (value: unknown): string | undefined => {
  const n = numberOf(value)
  return n === undefined ? undefined : decimal(n, 2)
}
const MODE_LABELS = { '2d': '二维地图', '3d': '三维场景', map: '二维地图', scene: '三维场景' }
const DRAW_LABELS = { point: '点', line: '线', polygon: '面', LineString: '线', Polygon: '面', Point: '点' }
const featureCount = (key: string) => field('要素数', key, v => countOf(v, '个'))
const layerTotal = field('当前图层数', 'total_layers', v => countOf(v, '个'))
const revisionArg = field('期望版本', 'expected_revision', idOf)
const useActionOf = (value: unknown): string | undefined =>
  enumOf(value, { pan: '平移', zoom: '缩放', click: '点击', finish: '结束' })
const observationSourcesOf = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined
  let basemaps = 0
  let vectors = 0
  let overlays = 0
  for (const source of value) {
    if (typeof source !== 'object' || source === null) continue
    const kind = (source as { kind?: unknown }).kind
    if (kind === 'basemap') basemaps += 1
    else if (kind === 'vector-layer') vectors += 1
    else if (kind === 'overlay') overlays += 1
  }
  const parts = [
    ...(basemaps > 0 ? ['底图'] : []),
    ...(vectors > 0 ? [`${vectors} 个矢量层`] : []),
    ...(overlays > 0 ? [`${overlays} 个覆盖层`] : []),
  ]
  return parts.length > 0 ? parts.join('、') : undefined
}
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
  map_refine_aoi: entry('精修候选轮廓', 'edit',
    [layerArg('candidate_id', '候选'), field('范围', 'bbox', bboxOf), field('建筑过滤', 'building', textOf), field('置信', 'confidence', textOf)],
    [field('图层', 'layer.name', textOf), field('足迹数', 'layer.feature_count', v => countOf(v, '个')), field('来源', 'source.attribution', textOf), field('许可', 'source.licence', textOf), field('置信', 'confidence', textOf), field('候选', 'selection_rule', textOf)]),
  map_set_view: entry('移动视图', 'edit',
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf), field('投影', 'wkid', idOf)],
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf)]),
  map_fit_view: entry('缩放到范围', 'edit',
    [layerArg(), field('范围', 'bbox', bboxOf), field('留白', 'padding', v => countOf(v, '像素'))],
    [field('中心', 'center', lonLatOf), field('缩放', 'zoom', zoomOf)]),
  map_set_mode: entry('切换显示模式', 'edit', [field('模式', 'mode', v => enumOf(v, MODE_LABELS))]),
  map_set_basemap: entry('切换底图', 'edit',
    [field('底图', 'source_id', idOf), field('注记', 'label_source_id', textOf)],
    [field('底图', 'selection.basemap.title', textOf), field('注记', 'selection.labels.title', textOf)]),
  map_set_imagery: entry('切换影像图层', 'edit',
    [
      field('参考注记', 'labels_visible', yesNoOf),
      field('近期影像', 'recent_visible', yesNoOf),
      field('透明度', 'recent_opacity', opacityOf),
      field('早期影像', 'early_visible', yesNoOf),
      field('早期版本', 'early_release_id', idOf),
    ],
    [
      field('参考注记', 'imagery_display.labelsVisible', yesNoOf),
      field('近期影像', 'imagery_display.recentVisible', yesNoOf),
      field('透明度', 'imagery_display.recentOpacity', opacityOf),
      field('早期影像', 'imagery_display.earlyVisible', yesNoOf),
      field('早期版本', 'imagery_display.earlySource.title', textOf),
    ]),
  map_list_basemaps: entry('查看底图目录', 'read',
    [field('来源', 'provider', textOf), field('位置', 'at', lonLatOf), field('缩放', 'zoom', zoomOf), field('页', 'page_size', v => countOf(v, '条'))],
    [field('目录版本', 'catalog_version', idOf), field('来源数', 'sources', v => lengthOf(v, '个')), field('下页', 'next_cursor', idOf)]),
  map_get_state: entry('读取地图状态', 'read', [],
    [field('地图版本', 'revision', idOf), field('图层数', 'layers', v => lengthOf(v, '个')), field('模式', 'mode', v => enumOf(v, MODE_LABELS))]),
  map_locate: entry('定位地点', 'search', [field('地点', 'query', textOf), field('范围', 'bbox', bboxOf)],
    [field('找到', 'found', yesNoOf), field('候选', 'candidates', v => lengthOf(v, '个')), field('来源', 'provider', textOf)]),
  map_observe: entry('观察地图画面', 'read',
    [field('等待上限', 'timeout_ms', millisOf), revisionArg],
    [
      field('地图版本', 'revision', idOf),
      field('观察编号', 'observation_id', idOf),
      field('图像', 'image', value => {
        const image = value as { width?: unknown; height?: unknown } | undefined
        const width = numberOf(image?.width)
        const height = numberOf(image?.height)
        return width === undefined || height === undefined ? undefined : `${width}×${height} 像素`
      }),
      field('来源', 'sources', observationSourcesOf),
      field('定位', 'positioning', v => enumOf(v, { 'affine-2d': '可定位', none: '仅图像' })),
    ]),
  map_compare_views: entry('比较两期地图画面', 'read',
    [field('前期观察', 'before_observation_id', idOf), field('后期观察', 'after_observation_id', idOf), field('关注目标', 'focus', textOf)],
    [
      field('对比编号', 'comparison_id', idOf),
      field('可比性', 'comparability', v => enumOf(v, { comparable: '可比较', limited: '有限', 'not-comparable': '不可比较' })),
      field('图像顺序', 'image_order', v => Array.isArray(v) ? v.length === 2 ? '前期、后期' : undefined : undefined),
      field('限制', 'limitations', v => Array.isArray(v) ? countOf(v.length, '项') : undefined),
    ]),
  map_use: entry('连续地图操作', 'edit',
    [field('动作', 'action', useActionOf), field('观察编号', 'observation_id', idOf), field('平移', 'dx_px', v => numberOf(v) === undefined ? undefined : `${numberOf(v)} 像素`)],
    [
      field('地图版本', 'revision', idOf),
      field('来源版本', 'source_revision', idOf),
      field('候选版本', 'candidate_revision', idOf),
      field('中心', 'center', lonLatOf),
      field('缩放', 'zoom', zoomOf),
      field('命中', 'hits', v => Array.isArray(v) ? countOf(v.length, '个') : undefined),
      field('剩余动作', 'budget.actionsRemaining', v => numberOf(v) === undefined ? undefined : `${numberOf(v)} 次`),
    ]),
  map_edit_annotation: entry('编辑地图标注', 'edit',
    [field('动作', 'change.op', textOf), revisionArg],
    [field('操作', 'operation_id', idOf), field('目标版本', 'target_revision', idOf)]),
  map_markup: entry('提出视觉候选', 'edit',
    [field('观察编号', 'observation_id', idOf), field('用途', 'purpose', v => enumOf(v, { sketch: '标绘', target: '目标' })), field('候选数', 'items', v => Array.isArray(v) ? countOf(v.length, '个') : undefined)],
    [field('候选数', 'candidates', v => countOf(v, '个')), field('状态', 'status', v => enumOf(v, { proposed: '待确认' })), field('限制', 'limitations', v => Array.isArray(v) ? countOf(v.length, '项') : undefined)]),
  map_mark_changes: entry('提出视觉变化候选', 'edit',
    [field('对比编号', 'comparison_id', idOf), field('候选数', 'items', v => Array.isArray(v) ? countOf(v.length, '个') : undefined)],
    [field('对比编号', 'comparison_id', idOf), field('候选数', 'candidates', v => countOf(v, '个')), field('状态', 'status', v => enumOf(v, { proposed: '待确认' })), field('限制', 'limitations', v => Array.isArray(v) ? countOf(v.length, '项') : undefined)]),
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
