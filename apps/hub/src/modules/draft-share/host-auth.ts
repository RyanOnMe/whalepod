import { timingSafeEqual } from 'node:crypto'
import { findDeviceByTokenHash, type Database, type DeviceRow } from '@whalepod/db'
import type { FastifyRequest } from 'fastify'
import type { ManagedDraftHost } from '../../config.js'
import { hashToken } from '../auth/token.js'

export async function deviceForNodeRequest(database: Database, request: FastifyRequest) {
  const header = request.headers.authorization
  const token =
    typeof header === 'string' && header.startsWith('Device ') ? header.slice(7).trim() : ''
  return token === '' ? undefined : findDeviceByTokenHash(database.db, hashToken(token))
}

export function matchesManagedDraftHost(
  request: FastifyRequest,
  host: ManagedDraftHost | undefined,
  device: DeviceRow | undefined,
  requiresTls: boolean,
): boolean {
  if (
    host === undefined ||
    device?.id !== host.deviceId ||
    device.ownerUserId !== host.ownerUserId ||
    device.revokedAt !== null
  )
    return false
  const proof = request.headers['x-whalepod-managed-host']
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false
  const transport = request.raw.socket
  const remote = transport.remoteAddress?.replace(/^::ffff:/, '')
  const secure = requiresTls
    ? ('encrypted' in transport && transport.encrypted === true) ||
      (remote !== undefined && remote === host.tlsProxyAddress && request.protocol === 'https')
    : remote === '127.0.0.1' || remote === '::1'
  return secure && timingSafeEqual(hashToken(proof), Buffer.from(host.proofSha256, 'hex'))
}
