"use client";

import { useState } from "react";
import { BaleOutbox } from "./bale-outbox";
import { BaleTestCard } from "./bale-test-card";

/**
 * Keeps the test button and the outbox list in sync: after every test attempt
 * the outbox is reloaded so the recorded message and its outcome appear.
 */
export function BalePanel() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <BaleTestCard onTestComplete={() => setRefreshKey((key) => key + 1)} />
      <BaleOutbox refreshKey={refreshKey} />
    </>
  );
}
