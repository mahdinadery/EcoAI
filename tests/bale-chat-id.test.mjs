import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateBaleChatIds,
  extractDiscoveredBaleChats,
  matchDiscoveredChat,
  normalizeBaleChatId,
} from "../src/lib/bale/client.ts";

test("normalizeBaleChatId normalizes ble.ir URLs, web.bale.ai uid URLs, bare handles, Persian numerals, and numeric IDs", () => {
  assert.equal(normalizeBaleChatId("4819203847"), "4819203847");
  assert.equal(normalizeBaleChatId("-10019283746"), "-10019283746");
  assert.equal(normalizeBaleChatId("۴۸۱۹۲۰۳۸۴۷"), "4819203847");
  assert.equal(normalizeBaleChatId("https://web.bale.ai/chat?uid=4829104829"), "4829104829");
  assert.equal(normalizeBaleChatId("https://web.bale.ai/chat?uid=44|4829104829"), "4829104829");
  assert.equal(normalizeBaleChatId("https://web.bale.ai/chat?uid=44%7C4829104829"), "4829104829");
  assert.equal(normalizeBaleChatId("44|4829104829"), "4829104829");
  assert.equal(normalizeBaleChatId("  \"@ecoai_channel\"  "), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("ecoai_channel"), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("https://ble.ir/ecoai_channel/"), "@ecoai_channel");
  assert.equal(normalizeBaleChatId("ble.ir/ecoai_channel"), "@ecoai_channel");
  // Private invite links are NOT turned into `@join`:
  assert.equal(normalizeBaleChatId("https://ble.ir/join/AbCdEfGh"), "https://ble.ir/join/AbCdEfGh");
  assert.equal(normalizeBaleChatId("   "), undefined);
});

test("candidateBaleChatIds covers positive, -100, and negative peer ID encodings plus lowercase @handle", () => {
  assert.deepEqual(candidateBaleChatIds("4829104829"), [
    "4829104829",
    "-1004829104829",
    "-4829104829",
  ]);
  assert.deepEqual(candidateBaleChatIds("-1004829104829"), [
    "-1004829104829",
    "4829104829",
    "-4829104829",
  ]);
  assert.deepEqual(candidateBaleChatIds("@EcoAI_Channel"), [
    "@EcoAI_Channel",
    "@ecoai_channel",
  ]);
});

test("extractDiscoveredBaleChats and matchDiscoveredChat resolve channels from Bale getUpdates", () => {
  const chats = extractDiscoveredBaleChats([
    {
      update_id: 1,
      channel_post: {
        chat: { id: -1005291048291, type: "channel", title: "اقتصاد هوش مصنوعی", username: "ecoai_ir" },
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
  assert.equal(matchDiscoveredChat("@ECOAI_IR", chats)?.id, "-1005291048291");
  assert.equal(matchDiscoveredChat("5291048291", chats)?.id, "-1005291048291");
});
