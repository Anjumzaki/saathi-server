import { z } from 'zod';

/** Field rules shared by more than one route. */
export const emailField = z.string().trim().toLowerCase().email().max(254);
export const phoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, e.g. +923001234567');
import { PASSWORD_MAX, PASSWORD_MIN } from '../utils/password';
/** Not trimmed: spaces are part of a password. */
export const passwordField = z.string().min(PASSWORD_MIN, `password must be at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX);
export const DISPLAY_NAME_MAX = 40;
/** A person's name: letters (any script), spaces and . ' ’ - only. */
export const displayNameField = z.string().trim().min(1).max(DISPLAY_NAME_MAX).regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u, 'name may only contain letters, spaces and . - \'');
export const termsVersionField = z.string().trim().min(1).max(20);
