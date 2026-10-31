import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { NEWS_STATUS_LABELS, NEWS_STATUS_TONES, type NewsStatus } from "@/lib/news/status";

/** Small shared renderer for a news lifecycle status value (server or client). */
export function NewsStatusTones({ status }: { status: string }) {
  const known = status in NEWS_STATUS_LABELS ? (status as NewsStatus) : null;
  const tone: StatusTone = known ? NEWS_STATUS_TONES[known] : "muted";
  return <StatusBadge tone={tone}>{known ? NEWS_STATUS_LABELS[known] : status}</StatusBadge>;
}
