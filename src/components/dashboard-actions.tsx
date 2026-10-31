"use client";

import { useState } from "react";
import { AutoSendCard } from "./auto-send-card";
import { BaleOutbox } from "./bale-outbox";
import { BaleTestCard } from "./bale-test-card";
import { NewsFetchCard } from "./news-fetch-card";
import { ScheduleCard } from "./schedule-card";

/**
 * Coordinates dashboard action cards so any automatic or manual send action
 * immediately updates the Local Outbox.
 *
 * `adminKey` comes from `?key=` on the dashboard URL (the same shared key the
 * admin pages use). It is only forwarded when present; otherwise the admin
 * session cookie set by the login popup is sent automatically.
 */
export function DashboardActions({ adminKey = "" }: { adminKey?: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <>
      <ScheduleCard adminKey={adminKey} onRunComplete={bump} />
      <NewsFetchCard adminKey={adminKey} onIngestComplete={bump} />
      <AutoSendCard adminKey={adminKey} onAutoSendComplete={bump} />
      <BaleTestCard adminKey={adminKey} onTestComplete={bump} />
      <BaleOutbox refreshKey={refreshKey} />
    </>
  );
}
