/**
 * Hostname and literal-address policy shared by source configuration and DNS.
 * Explicit private access never permits metadata, link-local or multicast IPs.
 * @module @map-harness/map-container/source-address
 */
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const privateIpRanges = new Set(['private', 'loopback', 'uniqueLocal', 'carrierGradeNat'])
const metadataHosts = new Set(['metadata', 'metadata.google.internal', 'metadata.azure.internal', 'metadata.tencentyun.com'])
const metadataAddresses = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254'])

/**
 * Check a configured hostname or IP without resolving it.
 * @param hostname - URL hostname; brackets and a terminal DNS dot are normalized.
 * @param allowPrivateNetwork - whether configured intranet/loopback access is allowed.
 * @returns whether configuration may reference this host; DNS remains unverified.
 */
export function sourceHostAllowed(hostname: string, allowPrivateNetwork: boolean): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (metadataHosts.has(host)) return false
  if (ipaddr.isValid(host)) {
    const address = ipaddr.process(host)
    if (metadataAddresses.has(address.toString())) return false
    const range = address.range()
    return range === 'unicast' || (allowPrivateNetwork && privateIpRanges.has(range))
  }
  const privateName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')
  return !privateName || allowPrivateNetwork
}

/**
 * Admit a DNS result as an actual permitted IP, not a second hostname.
 * @param address - address returned by the operation's resolver.
 * @param allowPrivateNetwork - deployment-only private-network permission.
 * @returns whether this literal is safe for the pinned connection.
 */
export function sourceResolvedAddressAllowed(address: string, allowPrivateNetwork: boolean): boolean {
  return isIP(address) !== 0 && sourceHostAllowed(address, allowPrivateNetwork)
}

/**
 * Check a DNS answer that is public but not a dialable unicast literal.
 * Teredo transition addresses are globally routed and never reach a private
 * network; a public host may publish one alongside its usable records.
 * @param address - address returned by the operation's resolver.
 * @returns whether the candidate may be dropped without refusing the answer.
 */
export function sourceResolvedAddressIgnorable(address: string): boolean {
  if (isIP(address) === 0) return false
  return ipaddr.process(address).range() === 'teredo'
}
