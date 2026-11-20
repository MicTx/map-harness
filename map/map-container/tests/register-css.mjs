import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    if (/\.css(?:$|\?)/.test(String(url))) {
      return { format: 'module', shortCircuit: true, source: 'export default {}' }
    }
    return nextLoad(url, context)
  },
})
