import type { BriefingConfig } from "@lownoise/core";

const ARABIC_MONTHS = [
  "كانون الثاني",
  "شباط",
  "آذار",
  "نيسان",
  "أيار",
  "حزيران",
  "تموز",
  "آب",
  "أيلول",
  "تشرين الأول",
  "تشرين الثاني",
  "كانون الأول"
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

export function formatArabicTimeParts(value: string): { month: string; day: string; time: string } {
  const date = new Date(value);
  const month = ARABIC_MONTHS[date.getMonth()] ?? "";
  const day = String(date.getDate());
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return { month, day, time: `${hour}:${minute}` };
}

export function formatTime(value: string, language: "en" | "ar" | "fr"): string {
  if (language === "ar") {
    const { month, day, time } = formatArabicTimeParts(value);
    return `${month} ${day}، ${time}`;
  }

  const locale = language === "fr" ? "fr-FR" : "en-GB";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}
