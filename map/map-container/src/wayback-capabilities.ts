/**
 * Admission of the official Wayback RESTful WMTS capabilities document.
 * Only the selected release's layer and real tile matrix survive parsing.
 * @module @map-harness/map-container/wayback-capabilities
 */
import { SourceCatalogError } from './source-error.ts'
import { parseSourceXml, xmlAttribute, xmlElement, xmlElements, xmlText, type SourceXmlElement } from './source-xml.ts'
import type { WmtsMetadata } from './source-wmts.ts'

function unavailable(): never {
  throw new SourceCatalogError('SOURCE_UNAVAILABLE')
}

function text(parent: SourceXmlElement, name: string): string {
  return xmlText(xmlElement(parent, name))
}

function number(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) unavailable()
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) unavailable()
  return result
}

/**
 * Parse the fixed release and default028mm grid into native WMTS metadata.
 * @param body - transport-bounded official capabilities XML.
 * @param releaseId - fixed numeric release, never a latest-version selector.
 * @param layerIdentifier - official WMTS layer id from the release catalog.
 * @param publishedAt - when supplied, the exact release date required in the matched layer title.
 * @returns validated matrix metadata for the controlled WMTS compiler.
 */
export function parseWaybackCapabilities(body: Uint8Array, releaseId: number, layerIdentifier: string, publishedAt?: string): WmtsMetadata {
  const capabilities = xmlElement(parseSourceXml(body), 'Capabilities')
  if (xmlAttribute(capabilities, 'version') !== '1.0.0') unavailable()
  const contents = xmlElement(capabilities, 'Contents')
  const expectedTemplate = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/{TileMatrixSet}/MapServer/tile/${releaseId}/{TileMatrix}/{TileRow}/{TileCol}`
  const allLayers = xmlElements(contents, 'Layer')
  const catalogLayers = allLayers.filter(layer => text(layer, 'Identifier') === layerIdentifier)
  if (catalogLayers.length !== 1) unavailable()
  const layers = allLayers.filter(layer =>
    xmlElements(layer, 'ResourceURL').some(item => item['@_resourceType'] === 'tile' && item['@_template'] === expectedTemplate))
  if (layers.length !== 1) unavailable()
  const layer = layers[0]!
  if (publishedAt !== undefined && text(layer, 'Title') !== `World Imagery (Wayback ${publishedAt})`) unavailable()
  const nativeLayer = text(layer, 'Identifier')
  if (!/^WB_\d{4}_R\d{2}$/.test(layerIdentifier) || !/^WB_\d{4}_R\d{2}$/.test(nativeLayer)
    || allLayers.filter(item => text(item, 'Identifier') === nativeLayer).length !== 1
    || nativeLayer !== layerIdentifier && !(releaseId === 15084 && layerIdentifier === 'WB_2015_R14' && nativeLayer === 'WB_2015_R04')) unavailable()
  if (xmlElements(layer, 'Dimension').length > 0 || !xmlElements(layer, 'Format').some(item => xmlText(item) === 'image/jpeg')) unavailable()
  const resourceTemplates = xmlElements(layer, 'ResourceURL').filter(item => item['@_resourceType'] === 'tile')
  if (resourceTemplates.length !== 1
    || xmlAttribute(resourceTemplates[0]!, 'format') !== 'image/jpeg'
    || xmlAttribute(resourceTemplates[0]!, 'template') !== expectedTemplate) unavailable()
  const styles = xmlElements(layer, 'Style').filter(item => text(item, 'Identifier') === 'default')
  if (styles.length !== 1) unavailable()
  const links = xmlElements(layer, 'TileMatrixSetLink').filter(link => text(link, 'TileMatrixSet') === 'default028mm')
  if (links.length !== 1) unavailable()
  const matrix = xmlElements(contents, 'TileMatrixSet').find(item => text(item, 'Identifier') === 'default028mm')
  if (matrix === undefined || !/^(?:EPSG:|urn:ogc:def:crs:EPSG:[\d.]*:)3857$/i.test(text(matrix, 'SupportedCRS'))) unavailable()
  const matrices = xmlElements(matrix, 'TileMatrix')
  if (matrices.length === 0 || matrices.length > 64) unavailable()
  const decoded = matrices.map((item, index) => {
    const nativeId = text(item, 'Identifier')
    const scale = number(text(item, 'ScaleDenominator'))
    const width = number(text(item, 'TileWidth'))
    const height = number(text(item, 'TileHeight'))
    const matrixWidth = number(text(item, 'MatrixWidth'))
    const matrixHeight = number(text(item, 'MatrixHeight'))
    if (![width, height, matrixWidth, matrixHeight].every(Number.isSafeInteger)
      || width > 4_096 || height > 4_096 || matrixWidth > 2 ** 32 || matrixHeight > 2 ** 32) unavailable()
    const corner = text(item, 'TopLeftCorner').split(/\s+/)
    if (corner.length !== 2 || !corner.every(value => Number.isFinite(Number(value)))) unavailable()
    return {
      nativeId,
      publicId: String(index),
      scaleDenominator: scale,
      viewScale: scale * 0.00028 * 96 / 0.0254,
      topLeftCorner: [Number(corner[0]), Number(corner[1])] as const,
      tileWidth: width,
      tileHeight: height,
      matrixWidth,
      matrixHeight,
      minTileRow: 0,
      maxTileRow: matrixHeight - 1,
      minTileCol: 0,
      maxTileCol: matrixWidth - 1,
    }
  })
  if (new Set(decoded.map(item => item.nativeId)).size !== decoded.length) unavailable()
  decoded.sort((left, right) => right.scaleDenominator - left.scaleDenominator)
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index - 1]!.scaleDenominator <= decoded[index]!.scaleDenominator) unavailable()
  }
  return {
    nativeWkid: 3857,
    nativeLayer,
    nativeStyle: 'default',
    nativeFormat: 'image/jpeg',
    nativeMatrixSet: 'default028mm',
    publicFormat: 'image/jpeg',
    matrices: decoded.map((item, index) => ({ ...item, publicId: String(index) })),
  }
}
