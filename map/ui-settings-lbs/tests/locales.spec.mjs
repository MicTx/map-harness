import test from 'node:test'
import assert from 'node:assert/strict'
import { LBS_VENDOR_IDS, LBS_KEY_MODES } from '../../lbs-keyring/src/contract.ts'
import {
  en, modeHintKey, modeLabelKey, vendorHintKey, vendorLabelKey, zh,
} from '../src/client/locales.ts'

test('zh and en carry the same non-empty key set', () => {
  const zhKeys = Object.keys(zh).sort()
  assert.deepEqual(Object.keys(en).sort(), zhKeys)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string')
    assert.ok(en[key].trim().length > 0, `${key} has empty English copy`)
  }
})

test('every vendor has a label and a hint in both dictionaries', () => {
  for (const vendorId of LBS_VENDOR_IDS) {
    for (const key of [vendorLabelKey(vendorId), vendorHintKey(vendorId)]) {
      assert.ok(key in zh, `missing zh key ${key}`)
      assert.ok(key in en, `missing en key ${key}`)
    }
  }
})

test('every usage mode has a label and a hint in both dictionaries', () => {
  for (const mode of LBS_KEY_MODES) {
    for (const key of [modeLabelKey(mode), modeHintKey(mode)]) {
      assert.ok(key in zh, `missing zh key ${key}`)
      assert.ok(key in en, `missing en key ${key}`)
    }
  }
})

test('status, action and failure copy is localized and never names a credential value', () => {
  const required = [
    'configured', 'notConfigured', 'active', 'standby', 'healthy', 'cooling',
    'disabled', 'readOnlyKey', 'addKey', 'removeKey', 'moveUp', 'moveDown',
    'clear', 'save', 'saving', 'saveFailed', 'unavailable', 'readOnly',
    'configuredSummary', 'maxKeys', 'removeLast', 'poolReadOnly', 'structureFailed',
    'rowFailed', 'keyLabel', 'keyReference', 'useCount', 'lastUsed', 'neverUsed',
    'intro', 'edit', 'apply', 'applying', 'cancel', 'add', 'addHint', 'remove',
    'deleteTitle', 'deleteDescription', 'deleteDescriptionWithCredential',
    'deleteConfirm', 'deleting', 'savedVendor', 'keyReveal', 'keyHide',
    'keyPlaceholder', 'keyPlaceholderSaved', 'credentialConfigured', 'credentialMissing',
    'customized', 'readOnlyNotice', 'loadFailed', 'retry', 'conflict',
    'deleteFailure', 'setupTitle', 'setupHint', 'apiKeyLabel',
  ]
  for (const key of required) {
    assert.ok(key in zh, `missing zh key ${key}`)
    assert.ok(key in en, `missing en key ${key}`)
  }
  assert.equal(Object.values(zh).some(text => text.includes('secret-value')), false)
  assert.equal(Object.values(en).some(text => text.includes('secret-value')), false)
})

test('the Models-page intro posture has a localized equivalent in LBS copy', () => {
  assert.match(zh.intro, /API 密钥/)
  assert.match(en.intro, /API key/)
  assert.ok(zh.setupHint.length > 0 && en.setupHint.length > 0)
})

test('English copy uses sentence case for the section title and navigation', () => {
  assert.equal(en.nav, 'LBS services')
  assert.equal(en.title, 'LBS service keys')
  assert.equal(en.nav[0], en.nav[0].toUpperCase())
  assert.equal(en.description.startsWith('Maintain'), true)
})
