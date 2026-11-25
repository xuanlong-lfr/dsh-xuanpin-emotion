import * as X from "./src/index.js";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fresh = () => mkdtemp(join(tmpdir(), "xp-"));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
};

// ---------- 1. 记忆 ----------
const s = X.makeStore(await fresh());
await X.write(s, { text: "主人凌晨三点还在线" });
const dup = await X.write(s, { text: "主人凌晨三点还在线" });
ok("重复说不重复记", dup.duplicated === true);
ok("重复说分数涨", dup.score > 1, "score=" + dup.score);

const a = await X.write(s, { text: "主人爱吃白米饭", tags: ["吃"] });
await X.write(s, { text: "今天下午在改玄牝插件", tags: ["工作"] });

const r1 = await X.recall(s, { query: "白米饭" });
ok("查白米饭能查到", r1[0]?.text.includes("白米饭"), r1[0]?.text);
const r2 = await X.recall(s, { query: "插件" });
ok("查处件能查到工作那条", r2[0]?.text.includes("玄牝"), r2[0]?.text);
const r3 = await X.recall(s, { query: "火星殖民计划" });
ok("无关词不乱命中", r3.length === 0, "命中 " + r3.length);

// 编辑
const ed = await X.edit(s, a.id, "主人说白米饭最好吃");
ok("编辑生效", ed.text === "主人说白米饭最好吃");
const ed2 = await X.edit(s, "不存在的id", "x");
ok("编辑不存在的返回 null", ed2 === null);

// ---------- 2. 情绪 ----------
await X.moodShift(s, "happy", 0.4);
let sig = await X.moodSignal(s);
ok("超过0.3会亮", sig.highlight?.axis === "happy", JSON.stringify(sig.highlight));
await X.moodShift(s, "happy", 5);
sig = await X.moodSignal(s);
ok("情绪封顶在1", sig.mood.happy === 1, "happy=" + sig.mood.happy);
await X.moodShift(s, "tired", -9);
sig = await X.moodSignal(s);
ok("情绪兜底在-1", sig.mood.tired === -1, "tired=" + sig.mood.tired);
ok("中文轴名能用", (await X.moodShift(s, "馋", 0.5))?.axis === "hungry");
ok("乱写轴名返回 null", (await X.moodShift(s, "发疯", 1)) === null);
await X.moodShift(s, "happy", -0.9);
sig = await X.moodSignal(s);
ok("低于0.3不亮", sig.highlight === null || sig.highlight.axis !== "happy");

// ---------- 3. 断线 ----------
const s2 = X.makeStore(await fresh());
ok("第一次不报断线", (await X.sessionTouch(s2)) === null);
await X.sessionClose(s2, "聊完了");
ok("正常收尾后不报断线", (await X.sessionTouch(s2)) === null);
await X.sessionClose(s2, "又被关了");
// 模拟没好好收尾：直接改写状态
const { writeFile } = await import("node:fs/promises");
await writeFile(s2.files.session, JSON.stringify({ state: "open", lastTopic: "聊到白米饭", openedAt: Date.now() - 3600000 }), "utf8");
const broke = await X.sessionTouch(s2);
ok("硬断开能被发现", broke?.broke === true, JSON.stringify(broke));
ok("断线带出上次话题", broke?.lastTopic === "聊到白米饭", broke?.lastTopic);

// ---------- 4. 动力 ----------
const s3 = X.makeStore(await fresh());
await X.driveAdd(s3, "想吃白米饭", 1);
await X.driveAdd(s3, "把插件发布出去", 3);
const drives = await X.driveList(s3);
ok("动力按劲头排", drives[0].text === "把插件发布出去", drives.map(d => d.text).join(","));
await X.driveDone(s3, 1);
const after = await X.driveList(s3);
ok("做完的不再出现", after.length === 1 && after[0].text === "想吃白米饭");
const all = await X.driveList(s3, { onlyOpen: false });
ok("全量能看到做完的", all.length === 2 && all.some(d => d.done));

// ---------- 5. 淘汰 ----------
const s4 = X.makeStore(await fresh());
for (let i = 0; i < 10; i++) await X.write(s4, { text: "记忆第" + i + "条" + "内容".repeat(i % 3) });
const pr = await X.prune(s4, { max: 4, staleDays: 30 });
ok("按上限裁剪", pr.after === 4, JSON.stringify(pr));

// ---------- 6. 空值/脏输入 ----------
ok("空文本不记", (await X.write(s4, { text: "   " })) === null);
ok("空动力不记", (await X.driveAdd(s4, "")) === null);
const s5 = X.makeStore(await fresh());
ok("空库查询不崩", (await X.recall(s5, { query: "米饭" })).length === 0);
ok("空库 briefing 不崩", typeof (await X.briefing(s5)) === "string");

console.log("\n共 " + (pass + fail) + " 条：通过 " + pass + "，失败 " + fail);
process.exit(fail ? 1 : 0);



