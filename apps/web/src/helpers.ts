import type { BriefingConfig } from "@distilled/core";

const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export function uniqueSlug(existing: BriefingConfig[], base: string): string {
  let slug = slugify(base);
  let suffix = 2;
  while (existing.some((item) => item.slug === slug)) {
    slug = `${slugify(base)}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

export function deriveBriefingSlug(existing: BriefingConfig[], title: string, currentId?: string): string {
  return uniqueSlug(
    existing.filter((item) => item.id !== currentId),
    title
  );
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "briefing"
  );
}

export function publicFeedUrl(username: string, slug: string, origin = window.location.origin): string {
  return new URL(`/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/`, origin).toString();
}

export function formatDateTime(value: string, language: "en" | "ar" | "fr" = "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  if (language === "en") {
    const month = ENGLISH_MONTHS[date.getMonth()] ?? "";
    const day = String(date.getDate());
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month} ${day}, ${hour}:${minute}`;
  }

  const locale = language === "ar" ? "ar-LB" : "fr-FR";
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const day = parts.day ?? String(date.getDate());
  const month = parts.month ?? String(date.getMonth() + 1);
  const hour = parts.hour ?? String(date.getHours()).padStart(2, "0");
  const minute = parts.minute ?? String(date.getMinutes()).padStart(2, "0");

  if (language === "ar") return `${day} ${month}، ${hour}:${minute}`;
  return `${day} ${month}, ${hour}:${minute}`;
}

export function formatTime(value: string, language: "en" | "ar" | "fr"): string {
  return formatDateTime(value, language);
}
