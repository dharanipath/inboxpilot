import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Browsers report CLDR's legacy names; people expect the current IANA ones. */
const LEGACY_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
};

export function normalizeTimeZone(tz: string): string {
  return LEGACY_ZONES[tz] ?? tz;
}

export function browserTimeZone(): string {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}
