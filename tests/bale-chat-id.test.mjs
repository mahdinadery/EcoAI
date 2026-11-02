import assert from "node:assert/strict";
import test from "node:test";

import { extractDiscoveredBaleChats, normalizeBaleChatId } from "../src/lib/bale/client.ts";

test("normalizeBaleChatId normalizes ble.ir URLs, bare handles, Persian numerals, and numeric IDs", () => {
  assert.equal(normalizeBaleChatId("4819203847"), "4819203847");
  assert.equal(normalizeBaleChatId("-10019283746"), "-10019283746");
  assert.equal(normalizeBaleChatId("۴۸۱۹۲۰۳۸۴۷"), "4819203847");
  assert.equal(normalizeBaleChatId("  \"@ecoai_channel\"  "), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("ecoai_channel"), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("https://ble.ir/ecoai_channel/"), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("ble.ir/ecoai_channel"), "@ecoai_channel");
  // Private invite links are NOT turned into `@join`:
  assert.equal(normalizeBaleChatId("https://ble.ir/join/AbCdEfGh"), "https://ble.ir/join/AbCdEfGh");
  assert.equal(normalizeBaleChatId("   "), undefined);
});

test("extractDiscoveredBaleChats extracts channels and groups from Bale getUpdates payloads", () => {
  const chats = extractDiscoveredBaleChats([
    {
      update_id: 1,
      channel_post: {
        chat: { id: 5291048291, type: "channel", title: "اقتصاد هوش مصنوعی", username: "ecoai_ir" },
      },
    },
    {
      update_id: 2,
      my_chat_member: {
        chat: { id: 4910293847, type: "channel", title: "کانال خصوصی تست" },
      },
    },
  ]);

  assert.equal(chats.length, 2);
  assert.deepEqual(chats[0], {
    id: "5291048291",
    type: "channel",
    title: "اقتصاد هوش مصنوعی",
    username: "ecoai_ir",
  });
  assert.deepEqual(chats[1], {
    id: "4910293847",
    type: "channel",
    title: "کانال خصوصی تست",
    username: null,
  });
});
