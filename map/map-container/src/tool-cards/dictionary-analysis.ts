/**
 * Dictionary entries for the data, catalog, decision, run, statistics,
 * decision-model, visualization, terrain, stream, and scale tool families.
 * @module @map-harness/map-container/tool-cards/dictionary-analysis
 */
import { entry, field, fieldArg, goalArg, layerArg, nameArg, pathArg, refArg, refResult, resourceArg, runArg, statusResult, streamArg, type PresentationEntry } from './entry.ts'
import { countOf, decimal, enumOf, fieldListOf, idOf, kilometersOf, lengthOf, lonLatOf, metersOf, millisOf, numberOf, textOf, yesNoOf } from './format.ts'

const minutesOf = (value: unknown): string | undefined => {
  const n = numberOf(value)
  return n === undefined ? undefined : `${decimal(n, 1)} 分钟`
}
const degreesOf = (value: unknown): string | undefined => {
  const n = numberOf(value)
  return n === undefined ? undefined : `${decimal(n, 1)}°`
}
const TRAVEL_LABELS = { walk: '步行', walking: '步行', drive: '驾车', driving: '驾车', bike: '骑行', cycling: '骑行', transit: '公交' }
const FORMAT_LABELS = { geojson: 'GeoJSON', csv: 'CSV', kml: 'KML', shapefile: 'Shapefile', shp: 'Shapefile' }
const CLASS_LABELS = { quantile: '分位数', 'equal-interval': '等间距', natural_breaks: '自然断点', 'natural-breaks': '自然断点', manual: '手动分级' }
const featureRefs = field('要素版本', 'total_feature_refs', v => countOf(v, '个'))
const resourceResult = refResult('resource.ref', '数据版本')
const outcomeArg = fieldArg('outcome_field', '结果字段')
const factorsArg = field('因素', 'factor_fields', fieldListOf)
const surfaceArg = refArg('surface_ref', '地表')
const classArgs = [field('字段', 'field', textOf), field('分级方法', 'classification', v => enumOf(v, CLASS_LABELS)), field('级数', 'class_count', v => countOf(v, '级'))]

/** Data, decision, analysis, visualization, terrain, stream, and scale entries. */
export const ANALYSIS_ENTRIES = {
  catalog_register: entry('登记数据', 'fetch', [nameArg(), pathArg(), field('在线地址', 'online', textOf), field('坐标系', 'crs', textOf)],
    [resourceResult, featureRefs, field('已去重', 'deduplicated', yesNoOf), statusResult]),
  catalog_resolve: entry('查找数据', 'search', [field('关键词', 'query', textOf), refArg('resource', '数据'), field('检索', 'search', textOf)],
    [resourceResult, featureRefs, statusResult]),
  data_import: entry('导入数据', 'fetch', [nameArg(), pathArg(), field('格式', 'format', v => enumOf(v, FORMAT_LABELS)), field('坐标系', 'crs', textOf)],
    [resourceResult, featureRefs, statusResult]),
  data_export: entry('导出数据', 'fetch', [nameArg(), layerArg(), refArg('ref', '数据'), field('格式', 'format', v => enumOf(v, FORMAT_LABELS))],
    [refResult('artifact.ref'), statusResult]),
  decision_update: entry('更新决策计划', 'edit', [goalArg, field('步骤', 'steps', v => lengthOf(v, '步')), field('证据', 'evidence_refs', v => lengthOf(v, '条'))],
    [field('计划版本', 'applied_plan_revision', idOf), statusResult]),
  run_submit: entry('提交可达性分析', 'execute', [goalArg, field('出行方式', 'travel_mode', v => enumOf(v, TRAVEL_LABELS)), field('时间上限', 'max_minutes', minutesOf), field('设施', 'facility_refs', v => lengthOf(v, '组'))],
    [field('任务', 'run_id', idOf), statusResult]),
  run_get: entry('查询分析任务', 'read', [runArg], [statusResult]),
  run_cancel: entry('取消分析任务', 'delete', [runArg], [statusResult]),
  stats_zonal: entry('分区统计', 'execute', [fieldArg(), fieldArg('zone_field', '分区字段'), resourceArg, goalArg], [statusResult]),
  stats_autocorrelation: entry('空间自相关', 'execute', [fieldArg(), field('邻域', 'band_meters', metersOf), resourceArg, goalArg], [statusResult]),
  stats_hotspot: entry('热点分析', 'execute', [fieldArg(), field('邻域', 'band_meters', metersOf), resourceArg, goalArg], [statusResult]),
  pattern_change: entry('时空变化检测', 'execute', [fieldArg(), fieldArg('time_field', '时间字段'), resourceArg, goalArg], [statusResult]),
  pattern_cluster: entry('时空聚类', 'execute', [fieldArg(), field('距离阈值', 'eps_meters', metersOf), resourceArg, goalArg], [statusResult]),
  pattern_flow: entry('移动流分析', 'execute', [fieldArg('entity_field', '对象字段'), field('网格', 'cell_meters', metersOf), resourceArg, goalArg], [statusResult]),
  attribution_association: entry('因素关联分析', 'execute', [outcomeArg, factorsArg, resourceArg, goalArg], [statusResult]),
  attribution_explain: entry('因素解释', 'execute', [outcomeArg, factorsArg, resourceArg, goalArg], [statusResult]),
  attribution_effect: entry('效应评估', 'execute', [outcomeArg, fieldArg('treatment_field', '处理字段'), resourceArg, goalArg], [statusResult]),
  forecast_validate: entry('预测模型验证', 'execute', [outcomeArg, field('模型', 'model_family', textOf), resourceArg, goalArg], [statusResult]),
  forecast_fit: entry('训练预测模型', 'execute', [outcomeArg, field('模型', 'model_family', textOf), resourceArg, goalArg], [statusResult]),
  forecast_predict: entry('生成预测', 'execute', [refArg('model_ref', '模型'), field('预测步数', 'horizon_steps', v => countOf(v, '步')), goalArg], [statusResult]),
  scenario_compare: entry('方案比选', 'execute', [field('候选方案', 'candidates', v => lengthOf(v, '个')), goalArg], [statusResult]),
  location_allocate: entry('选址优化', 'execute', [field('候选点', 'sites', v => lengthOf(v, '个')), field('覆盖半径', 'coverage_radius_meters', metersOf), resourceArg, goalArg], [statusResult]),
  viz_create_style: entry('创建专题样式', 'edit', [...classArgs, resourceArg],
    [layerArg(), field('渲染值', 'rendered_value_count', v => countOf(v, '个'))]),
  viz_classify: entry('分级设色', 'edit', [layerArg(), ...classArgs], [layerArg(), statusResult]),
  viz_compare: entry('对比专题图', 'edit', [layerArg('layer_a', '图层 A'), layerArg('layer_b', '图层 B'), field('字段', 'field', textOf)], [statusResult]),
  viz_aggregate: entry('网格聚合', 'execute', [layerArg(), resourceArg, field('网格', 'cell_size', metersOf)], [layerArg(), statusResult]),
  viz_density: entry('密度分析', 'execute', [layerArg(), field('半径', 'radius_km', kilometersOf)],
    [field('点数', 'points', v => countOf(v, '个')), refResult('artifact.ref'), statusResult]),
  viz_export_kml: entry('导出 KML', 'fetch', [nameArg(), layerArg()], [field('地标', 'placemarks', v => countOf(v, '个')), refResult('artifact.ref'), statusResult]),
  terrain_add_layer: entry('添加地形', 'edit', [nameArg(), layerArg(), refArg('ref', '高程数据')],
    [field('图层', 'layer.name', textOf), field('当前图层数', 'total_layers', v => countOf(v, '个'))]),
  geo_line_of_sight: entry('通视分析', 'execute', [field('观察点', 'observer', lonLatOf), field('目标点', 'target', lonLatOf), surfaceArg],
    [field('水平距离', 'horizontal_distance_m', metersOf), field('最小净空', 'min_clearance_m', metersOf), statusResult]),
  terrain_viewshed: entry('可视域分析', 'execute', [field('观察点', 'observer', lonLatOf), field('半径', 'radius_m', metersOf), surfaceArg], [statusResult]),
  terrain_slope: entry('坡度分析', 'execute', [refArg('ref', '高程数据'), fieldArg('elevation_field', '高程字段')],
    [field('平均坡度', 'slope_mean_deg', degreesOf), field('最大坡度', 'slope_max_deg', degreesOf), statusResult]),
  stream_open: entry('打开实时数据流', 'execute', [nameArg(), streamArg, refArg('scenario_ref', '场景'), field('时间窗', 'window_ms', millisOf)],
    [field('数据流', 'stream_id', idOf), statusResult]),
  stream_advance: entry('推进数据流', 'execute', [streamArg, field('步数', 'steps', v => countOf(v, '步'))], [statusResult]),
  stream_pause: entry('暂停数据流', 'edit', [streamArg], [statusResult]),
  stream_resume: entry('恢复数据流', 'edit', [streamArg], [statusResult]),
  stream_materialize: entry('固化数据流结果', 'fetch', [streamArg], [statusResult]),
  scale_ingest: entry('分块入库大数据', 'fetch', [refArg('source_ref', '源数据'), field('分块行数', 'chunk_rows', v => countOf(v, '行'))],
    [field('数据版本', 'scale_ref', idOf), field('分块', 'chunks', v => countOf(v, '块')), field('行数', 'rows', v => countOf(v, '行'))]),
  scale_read: entry('读取大数据分块', 'read', [resourceArg, field('读取', 'chunks', v => countOf(v, '块'))],
    [field('已读分块', 'chunks_read', v => countOf(v, '块')), field('命中', 'matches', v => countOf(v, '条'))]),
  scale_scan: entry('扫描大数据', 'search', [resourceArg, fieldArg()], [statusResult]),
} satisfies Record<string, PresentationEntry>
