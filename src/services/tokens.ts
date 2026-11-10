import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { getEnv } from '../config/env';
import { RefreshToken } from '../models/RefreshToken';
import { unauthorized } from '../utils/errors';
import { sha256 } from '../utils/crypto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
}

export function signAccessToken(userId: string, roles: string[]): string {
  const env = getEnv();
  return jwt.sign({ roles }, env.JWT_ACCESS_SECRET, { subject: userId, expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): { userId: string; roles: string[] } {
  try {
    const p = jwt.verify(token, getEnv().JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub) throw new Error('no sub');
    return { userId: p.sub, roles: Array.isArray(p['roles']) ? (p['roles'] as string[]) : [] };
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

export async function issueTokenPair(userId: Types.ObjectId | string, roles: string[], familyId: string = randomUUID()): Promise<TokenPair> {
  const env = getEnv();
  const jti = randomUUID();
  const ttl = env.REFRESH_TOKEN_TTL_DAYS * 86_400;
  const refreshToken = jwt.sign({ fam: familyId }, env.JWT_REFRESH_SECRET, { subject: String(userId), jwtid: jti, expiresIn: ttl, algorithm: 'HS256' });
  await RefreshToken.create({ userId, jtiHash: sha256(jti), familyId, expiresAt: new Date(Date.now() + ttl * 1000) });
  return { accessToken: signAccessToken(String(userId), roles), refreshToken, accessExpiresInSeconds: env.ACCESS_TOKEN_TTL_MIN * 60 };
}

/** Rotate a refresh token. Re-use of an already-rotated token revokes the whole family (theft signal). */
export async function rotateRefreshToken(
  token: string,
  loadRoles: (userId: string) => Promise<string[] | null>,
): Promise<TokenPair> {
  let p: jwt.JwtPayload;
  try {
    p = jwt.verify(token, getEnv().JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }
  if (!p.sub || !p.jti || typeof p['fam'] !== 'string') throw unauthorized('Invalid refresh token');
  const rec = await RefreshToken.findOne({ jtiHash: sha256(p.jti) });
  if (!rec) throw unauthorized('Invalid refresh token');
  if (rec.revokedAt) {
    await RefreshToken.updateMany({ familyId: rec.familyId, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('Refresh token re-use detected; please sign in again');
  }
  const roles = await loadRoles(p.sub);
  if (!roles) throw unauthorized('Account not found');
  rec.revokedAt = new Date();
  await rec.save();
  return issueTokenPair(p.sub, roles, rec.familyId);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  try {
    const p = jwt.verify(token, getEnv().JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (p.jti) await RefreshToken.updateMany({ familyId: String(p['fam']) }, { revokedAt: new Date() });
  } catch {
    /* already invalid: nothing to revoke */
  }
}
