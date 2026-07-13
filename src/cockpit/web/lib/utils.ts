import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui standard cn() helper — composes clsx + tailwind-merge.
 *
 * Also exported from src/cockpit/web/lib/cn.ts (existing Cockpit usage); this
 * file is the shadcn-convention path that components/ui/* primitives import.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
