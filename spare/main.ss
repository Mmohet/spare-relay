// Relay：待机只有居中的状态胶囊，总管有了汇报就从胶囊下面长出一张卡片；表冠往下进总管的页面，胶囊滑到左上角，像终端一样最新的在最底下；单击进目录挑会话。
// 网关排好每一行（第一个字是行的种类），眼镜只负责摆放、滚动、弹窗、录音和过渡。
// 图片编号就是 assets/ 里的文件名前缀：0-3 亮的 Agent，4-7 暗的，8 Relay，9-20 动作图标（亮暗成对），21-23 状态，24/25 Hermes 亮/暗，26/31 Antigravity 亮/暗，27/28 DeepSeek 亮/暗，29/30 总管 亮/暗。
// 胶囊里的格位不是 Agent 的身份：网关按 relay setup 启用的顺序排，眼镜从 g 里读每一格是谁。
// 行的种类：a b c Agent 的话（c 是一条新消息，b 是新段落），h i j 同样但是重点；v u 你说的（v 是第一行），r q 排着队的。

var view = 0;           // 0 待机  1 Agent 页  2 目录  3 新开  4 空屏（省电：什么都不画、不跑、不发请求）
var ag = 0;             // 当前 Agent（身份，不是格位）：0 Codex  1 Claude  2 Muse  3 Grok  4 DeepSeek  5 总管  6 Hermes  7 Antigravity
var off = 0;            // 从最新往上翻了几行；0 = 在最底下，跟着 Agent 走
var wo = 0;             // 手上这 16 行里最下面一行离最新几行
var wl = 0;             // 手上有几行；0 = 数据表里的行被弹窗的回复盖掉了，先不重画
var tn = 0;             // 会话一共几行
var tm = 0;             // 会话一共几条消息
var lm = 0;             // 离开最底下时有几条消息，用来数新消息
var fl = "";            // 三个字：w 能写 / r 只读，q 排队 / d 直接发，r 在跑 / w 等你 / i 空闲 / o 离线 / n 没有会话
var sid = "";            // 页面钉住的会话；读页、说话都带着它，Agent 别的会话更新了也不跳过去
var ucur = -1;          // 更新卡片看到了哪条（网关的序号）；-1 = 刚打开，从现在算起
var uk = "";            // 手上这张更新卡片：u + Agent + 会话；空 = 没有
var ui = "";            // 卡片的 i：U + 排着几个会话 + 这一条的序号
var uat = 0;            // 卡片露出来的时间，满 6 秒换下一张
var ut = "";            // 卡片在页面底部胶囊里的那一句
var ttl = "";
var act = "";           // 会话在跑时它正在做什么（网关排好，已经省略过）
var mx = -1;            // 麦克风现在的横坐标：在跑时让到右边；-1 = 刚打开，不滑
var g = "";             // 状态：总管两字节（w 有没看的汇报 / r 在跑 / i 空闲 / o 离线，加 0），然后每个启用的 Agent 三字节：身份、状态（w 等你）、忙着的会话数
var v = "";             // 版本号：总管两字，然后每个启用的 Agent 两字（顺序同 g），变了就重新取这一页；后面跟最新一条汇报的身份和序号
var pc = "";            // 弹窗里那件事：种类 + Agent + 编号；空 = 没有
var pop = 0;            // 0 没有弹窗  1 展开  2 收成底部的悬浮胶囊
var pa = 0;
var pid = "";
var ph = "";
var p1 = "";
var p2 = "";
var p3 = "";
var pitems = "";        // 弹窗里每一行一个字：h 先看历史  1-6 选项  m 说话回答  a 本会话都允许  y 允许  n 拒绝
var psel = 0;
var ptop = 0;
var o1 = "";
var o2 = "";
var o3 = "";
var o4 = "";
var o5 = "";
var o6 = "";
var rec = 0;            // 1 正在听
var rarg = "";
var heard = "";
var downAt = -5000;     // 上一次往下转的时间：到底以后要停 0.3 秒，下一格才离开这一页
var an = 0;             // 动画走到第几步
var am = 0;             // 哪种动画；0 = 没有在播
var tt = "";            // 页头的临时提示
var fresh = 0;          // 新换的页，内容到了要淡入
var bcon = 0;
var last = -5000;
var qa = -1;            // 排着队的用户动作（回答、说话、结束听写）
var qarg = "";
var wantL = 0;
var wantA = 0;
var wantN = 0;
var sNow = 0;
var sLens = 0;
var sAsk = 0;
var sCmd = 0;
var kCmd = 0;
var ds = 0;             // 翻历史的滑动：从哪一行开始摆，离 off 几行（往上翻时是负的）
var sy = 0;             // 还差多少像素滑到位：正的往下滑，负的往上滑（目录也用：行比该在的位置低多少）
var sn = 0;             // 滑动还剩几帧；0 = 没在滑
var vlo = -1;           // 上一次画出来的是哪几行（离最新几行）；滑动时不在里面的行才淡入
var vhi = -1;
var dsel = -1;          // 目录里选中第几个（第 0 个是新建会话）；从目录打开的会话也留着它（>= 0），底部再往下转回目录；-2 = 回目录时落到原来那个会话；-3 = 从空屏进的总管，底部回空屏
var hx = -1;            // 页头现在往右挪了多少：待机居中 172，页面和待机提示贴左 0；-1 = 刚打开，不滑

// ---------- 请求：手机限 1 次/秒。用户动作优先，然后是弹窗、这一页、状态 ----------

fn fire(q, arg) {
  last = now();
  var s = request(q, arg);
  if (q == q_now) { sNow = s; } else if (q == q_lens || q == q_dir) { sLens = s; } else if (q == q_ask) { sAsk = s; }
  else if (q != q_mic) { sCmd = s; kCmd = q; }
}

fn pump() {
  if (!connected()) { return; }
  if (qa < 0 && !wantA && !wantL && !wantN) { return; }
  var gap = now() - last;
  if (gap < 1050) { timer(3, 1100 - gap, 0); return; }
  if (qa >= 0) { var q = qa; qa = -1; fire(q, qarg); }
  else if (wantA == 1) { wantA = 0; fire(q_ask, pid); }
  else if (wantL && view == 1) {
    // 1 留在钉住的会话  3 弹窗里那件事的会话
    var la = letter(ag) + str(off);
    if (wantL == 3) { la = la + "r" + pid; }
    else if (sid != "") { la = la + "s" + sid; }
    wantL = 0;
    fire(q_lens, la);
  }
  else if (wantL && view == 2) {
    // 目录：选中的第几个附近八行；4 = 落到刚才看的那个会话
    var da = str(max(0, dsel));
    if (wantL == 4 && sid != "") { da = "s" + sid; }
    wantL = 0;
    fire(q_dir, da);
  }
  else if (wantA == 2 && sAsk == 0) {
    // 下一张更新卡片；页面上正看着的这个会话不算
    var ua = "u----";
    if (view == 1 && sid != "") { ua = "u" + sid; }
    wantA = 0;
    fire(q_ask, ua + str(ucur));
  }
  else if (wantN) { wantN = 0; fire(q_now, ""); }
  else { wantL = 0; }
  if (qa >= 0 || wantA || wantL || wantN) { timer(3, 1100, 0); }
}

fn cmd(q, arg) { qa = q; qarg = arg; pump(); }
fn need_lens() { if (!wantL) { wantL = 1; } pump(); }

// ---------- 小工具 ----------

fn letter(i) { if (i == 1) { return "k"; } if (i == 2) { return "m"; } if (i == 3) { return "g"; } if (i == 4) { return "d"; } if (i == 5) { return "z"; } if (i == 6) { return "h"; } if (i == 7) { return "v"; } return "c"; }
fn aname(i) { if (i == 1) { return "Claude"; } if (i == 2) { return "Muse"; } if (i == 3) { return "Grok"; } if (i == 4) { return "DeepSeek"; } if (i == 5) { return "总管"; } if (i == 6) { return "Hermes"; } if (i == 7) { return "Antigravity"; } return "Codex"; }
fn ael(i) { if (i == 1) { return a1; } if (i == 2) { return a2; } if (i == 3) { return a3; } if (i == 4) { return a4; } if (i == 5) { return a5; } if (i == 6) { return a6; } return a0; }
// 第 i 格是哪个 Agent；没有这一格是 -1
fn who(i) { if (i < 0 || len(g) < 5 + i * 3) { return -1; } return num(sub(g, 2 + i * 3, 1)); }
// Agent a 在第几格；没启用是 -1
fn slotof(a) { var i = 0; while (who(i) >= 0) { if (who(i) == a) { return i; } i += 1; } return -1; }
fn lel(k) {
  if (k == 1) { return l1; } if (k == 2) { return l2; } if (k == 3) { return l3; } if (k == 4) { return l4; }
  if (k == 5) { return l5; } if (k == 6) { return l6; } return l7;
}
fn oel(k) { if (k == 1) { return po1; } if (k == 2) { return po2; } if (k == 3) { return po3; } return po4; }
fn iel(k) { if (k == 1) { return pi1; } if (k == 2) { return pi2; } if (k == 3) { return pi3; } return pi4; }
fn agimg(a, hi) {
  var b = a;
  var d = a + 4;
  if (a == 4) { b = 27; d = 28; } else if (a == 6) { b = 24; d = 25; } else if (a == 7) { b = 26; d = 31; }
  if (hi) { return b; }
  return d;
}

fn pic(el, x, y, i) { image(el, i); move(el, x, y); show(el, 1); }
fn box(el, x, y, w, h) { move(el, x, y); size(el, w, h); show(el, 1); }
fn put(el, x, y, gv, s) { gray(el, gv); move(el, x, y); text(el, s); show(el, 1); }

// ---------- 页头：待机时胶囊居中，进页面或待机要显示一句话时滑到左上角；启用的 Agent（最多七个）的状态一直在 ----------
// 图标本身表示状态：等你的一闪一闪（计时器 1），在跑的亮，空闲、离线的暗

fn slide(d) {
  anim_x(cap, d, 0, 280); anim_x(hub, d, 0, 280);
  anim_x(a0, d, 0, 280); anim_x(a1, d, 0, 280); anim_x(a2, d, 0, 280); anim_x(a3, d, 0, 280); anim_x(a4, d, 0, 280);
  anim_x(a5, d, 0, 280); anim_x(a6, d, 0, 280);
  if (view == 1 || view == 3) { anim_x(sel, d, 0, 280); }
}

// 弹窗和听写的框只描边：页头先藏起来，免得从框里透出来
fn hide_head() {
  show(cap, 0); show(hub, 0); show(a0, 0); show(a1, 0); show(a2, 0); show(a3, 0); show(a4, 0);
  show(a5, 0); show(a6, 0); show(sel, 0); show(hdr, 0); show(clk, 0);
}

// 胶囊里的图标一起淡入淡出；胶囊的框只描边，不能淡，进空屏时往中间收
fn fade_head(a, b) {
  anim_opa(hub, a, b, 300);
  anim_opa(a0, a, b, 300); anim_opa(a1, a, b, 300); anim_opa(a2, a, b, 300); anim_opa(a3, a, b, 300); anim_opa(a4, a, b, 300);
  anim_opa(a5, a, b, 300); anim_opa(a6, a, b, 300);
}

fn draw_head() {
  if ((pop == 1 && am != 3 && am != 4) || rec) { hide_head(); return; }
  var n = max(0, (len(g) - 2) / 3);
  var t = ttl;
  var gv = 130;
  // 一个 Agent 都没启用（网关升级后还没跑过向导）：待机和目录都提示去 Mac 上跑 relay setup
  if (view == 0) { t = ""; if (n == 0 && g != "") { t = "到 Mac 上运行 relay setup"; gv = 200; } }
  else if (view == 2) { t = "最近的会话"; if (n == 0) { t = "到 Mac 上运行 relay setup"; } }
  else if (view == 3) {
    gv = 200;
    t = "单击说话 · 开新的 " + aname(ag) + " 会话";
    if (ag == 2) { t = "单击说话 · 开新的 Muse 子对话"; } else if (ag == 3) { t = "Grok 暂不支持从眼镜新开"; }
  }
  else if (sub(fl, 0, 1) == "r") { t = "只读 · " + ttl; }
  if (tt != "") { t = tt; gv = 255; }
  // 胶囊宽度跟着启用的个数走，待机时居中
  var w = 48 + n * 34;
  var nx = 264 - w / 2;
  if (view != 0 || t != "") { nx = 0; }
  if (view == 0 && nx == 0) { w = 528; }
  var d = hx - nx;
  if (hx < 0) { d = 0; }
  hx = nx;
  // 胶囊最左边是总管：有没看的汇报或者正在整理时亮，打开它的页面或者它的汇报卡片时也亮
  var hc = sub(g, 0, 1);
  var hub5 = (view == 1 && ag == 5) || (view == 0 && cardvis() && sub(uk, 1, 1) == "5");
  var hi = 30;
  if (hc == "w" || hc == "r" || hub5) { hi = 29; }
  pic(hub, 14 + nx, 11, hi);
  // 总管页只留在跑和等你的 Agent，往左挤；空出来的地方放时间和电量
  var zg = view == 1 && ag == 5;
  var i = 0;
  var k = 0;
  while (i < 7) {
    var a = who(i);
    var c = sub(g, 3 + i * 3, 1);
    if (a < 0 || (zg && c != "w" && c != "r")) { show(ael(i), 0); }
    else {
      var lit = c == "w" || c == "r" || ((view == 1 || view == 3) && a == ag) || (view == 0 && cardvis() && a == num(sub(uk, 1, 1)));
      pic(ael(i), 48 + nx + k * 34, 11, agimg(a, lit));
      k += 1;
    }
    i += 1;
  }
  var hw = 466 - k * 34;
  if (zg) { w = 48 + k * 34; hw -= 110; put(clk, 430, 12, 130, pad(clock() / 60, 2) + ":" + pad(clock() % 60, 2) + "  " + str(battery()) + "%"); }
  else { show(clk, 0); }
  move(cap, 6 + nx, 4); size(cap, w, 34); show(cap, 1);
  if (hub5) { box(sel, 9 + nx, 7, 30, 28); }
  else if (view == 1 || view == 3) { box(sel, 43 + slotof(ag) * 34, 7, 30, 28); }
  else if (view == 0 && cardvis()) { box(sel, 43 + nx + slotof(num(sub(uk, 1, 1))) * 34, 7, 30, 28); }
  else { show(sel, 0); }
  // 标题从胶囊右边开始，宽度给到屏幕右边
  if (t == "") { show(hdr, 0); } else { put(hdr, 64 + k * 34, 12, gv, t); size(hdr, hw, 20); }
  // 眼镜本地播的横移：先摆到终点，再从原来的位置滑过去
  if (d != 0) { slide(d); if (t != "") { anim_opa(hdr, 0, 255, 320); } }
  draw_card();
}

fn toast(t) { tt = t; draw_head(); timer(2, 2200, 0); }

// ---------- Agent 页：从最底下往上摆，最新的一行贴着底边 ----------

fn shade(c) {
  if (c == "h" || c == "i" || c == "j") { return 255; }
  if (c == "v" || c == "u") { return 235; }
  if (c == "r" || c == "q") { return 130; }
  return 205;
}

fn gapof(c) {
  if (c == "v" || c == "r") { return 12; }
  if (c == "c" || c == "j") { return 10; }
  if (c == "b" || c == "i") { return 5; }
  return 0;
}

// 你说的话不用填充，只描一圈边。框的亮度写死在清单里：运行时改亮度会把框填实
fn frame(i, y, h, dim) {
  if (i > 1) { return; }
  var el = u1;
  if (i == 1) { el = u2; }
  box(el, 14, y, 514, h);
}

fn hide_page() {
  show(u1, 0); show(u2, 0); show(u3, 0); show(u4, 0); show(e1, 0); show(e2, 0); show(dots, 0); show(sb, 0); show(bl, 0); show(mic, 0);
  show(l1, 0); show(l2, 0); show(l3, 0); show(l4, 0); show(l5, 0); show(l6, 0); show(l7, 0);
}

// 新内容淡入；换 Agent 时再从右边滑进来
fn fade_page(sl) {
  anim_opa(l1, 0, 255, 240); anim_opa(l2, 0, 255, 240); anim_opa(l3, 0, 255, 240); anim_opa(l4, 0, 255, 240);
  anim_opa(l5, 0, 255, 240); anim_opa(l6, 0, 255, 240); anim_opa(l7, 0, 255, 240);
  // 只描边的框不能做淡入：淡入会把它填实
  anim_opa(e1, 0, 255, 240); anim_opa(e2, 0, 255, 240);
  if (sl) {
    anim_x(l1, 40, 0, 260); anim_x(l2, 40, 0, 260); anim_x(l3, 40, 0, 260); anim_x(l4, 40, 0, 260);
    anim_x(l5, 40, 0, 260); anim_x(l6, 40, 0, 260); anim_x(l7, 40, 0, 260); anim_x(e1, 40, 0, 260); anim_x(e2, 40, 0, 260);
    anim_x(u1, 40, 0, 260); anim_x(u2, 40, 0, 260);
  }
}

// 从第 a 行到第 b 行之前（离最新的行数）一共多高；手上没有这些行就是 0
fn rowsh(a, b) {
  var h = 0;
  var i = a;
  while (i < b) {
    var idx = wl - (i - wo);
    if (idx < 1 || idx > wl) { return 0; }
    h += 30 + gapof(sub(data("d" + str(idx)), 0, 1));
    i += 1;
  }
  return h;
}

// 翻历史：眼镜没有上下的本地动画，用计时器分三帧滑过去（马上走一半，0.1 秒到八成，0.2 秒到位）
fn glide(was) {
  settle();
  var a = min(was, off);
  var h = rowsh(a, max(was, off));
  if (am != 0 || a < wo || h <= 0) { draw_page(); return; }
  ds = a - off;
  sy = h;
  if (off < was) { sy = -h; }
  sy = sy * 11 / 20;
  sn = 2;
  draw_page();
  timer(0, 100, 1);
}

fn settle() {
  if (sn > 0) { sn = 0; timer(0, 0, 0); }
  ds = 0; sy = 0;
}

// 内容区在 y 40 到 168 之间，一行 30 高（24 号字），最新一行贴着底边那条线；线下面正中是麦克风
fn draw_page() {
  if (view == 2) { draw_dir(); return; }
  if (view != 1) { return; }
  if (wl > 0) {
    hide_page();
    var j = off + ds;
    var y = 168 + rowsh(j, off) - sy;
    // 听写时顶上长出的那一截盖住了上面两行
    var top = 40;
    if (rec) { top = 80; }
    var k = 1;
    var e1u = 0;
    var e2u = 0;
    var lo = -1;
    var hi = -1;
    var bx = 0;
    var bb = -1;
    var dim = 0;
    var cut = 0;
    while (k <= 7 && j < tn) {
      var idx = wl - (j - wo);
      if (idx < 1 || idx > wl) { cut = 1; break; }
      if (y - 30 < top) { break; }
      var r = data("d" + str(idx));
      var c = sub(r, 0, 1);
      y -= 30;
      // 滑动时还在底边下面的行先不摆；你说的话露出上半截时，框先画到底边
      if (y > 138) {
        if ((c == "u" || c == "q") && bb < 0) { bb = 168; dim = c == "q"; }
        if (c == "v" || c == "r") { bb = -1; }
        y -= gapof(c);
        j += 1;
        continue;
      }
      var x = 14;
      if (c == "v" || c == "u" || c == "r" || c == "q") {
        x = 26;
        if (bb < 0) { bb = y + 30; dim = c == "r" || c == "q"; }
      }
      // 每行固定用同一个元素，滑动的几帧里淡入才跟着那一行走
      var el = lel(j % 7 + 1);
      if (c == "h" || c == "i" || c == "j") {
        if (j % 2 == 0 && !e1u) { el = e1; e1u = 1; }
        else if (!e2u) { el = e2; e2u = 1; }
        else if (!e1u) { el = e1; e1u = 1; }
      }
      put(el, x, y, shade(c), sub(r, 1, len(r) - 1));
      if (sn > 0 && (j < vlo || j > vhi)) { anim_opa(el, 0, 255, 260); }
      if (lo < 0) { lo = j; }
      hi = j;
      if ((c == "v" || c == "r") && bb >= 0) { frame(bx, y - 3, bb - y + 4, dim); bx += 1; bb = -1; }
      y -= gapof(c);
      j += 1;
      k += 1;
    }
    if (bb >= 0) { frame(bx, top, bb - top + 1, dim); }
    vlo = lo; vhi = hi;
    // 翻历史时右边一条细的进度条：长短是能看到的比例，位置是翻到了哪
    if (off > 0 && tn > 4) {
      var mx = max(1, tn - 4);
      var h = clamp(126 * 4 / tn, 12, 126);
      box(sb, 533, 168 - h - (126 - h) * min(off, mx) / mx, 3, h);
    }
    if (cut) { need_lens(); }
    if (fresh) { fade_page(fresh == 2); fresh = 0; }
  }
  box(bl, 14, 172, 512, 1);
  draw_bottom();
}

// ---------- 更新卡片：哪个会话说了新的话就跳出来，一次一张排着队。待机时从胶囊下面长出来，页面上收成底部的胶囊 ----------

// 卡片现在露得出来：没有弹窗、没在听写，在待机或者页面的最底下
fn cardvis() { return uk != "" && pop == 0 && rec == 0 && (view == 0 || (view == 1 && off == 0)); }

fn draw_card() {
  if (view != 0 || am != 0 || pop != 0 || rec) { return; }
  if (uk == "") { show(pbox, 0); hide_kids(); return; }
  var n = 1;
  if (p2 != "") { n = 2; }
  if (p3 != "") { n = 3; }
  var c = num(sub(ui, 1, 1));
  var hd = ph;
  var hint = "单击打开 · 转表冠收起";
  if (c > 1) { hd = ph + " · 还有 " + str(c - 1) + " 条"; hint = "单击打开 · 转表冠看下一条"; }
  box(pbox, 6, 44, 528, 64 + n * 24);
  put(phd, 22, 52, 150, hd);
  put(pq1, 22, 74, 245, p1);
  if (n > 1) { put(pq2, 22, 98, 245, p2); } else { show(pq2, 0); }
  if (n > 2) { put(pq3, 22, 122, 245, p3); } else { show(pq3, 0); }
  // 提示用小字：页面行的元素是大字，放这里会比卡片正文还大
  put(dots, 22, 82 + n * 24, 110, hint);
}

// 这张看过了；后面还排着就去取下一张。go = 1 接着要打开它，不用收
fn card_next(go) {
  ucur = max(ucur, num(sub(ui, 2, 8)));
  if (num(sub(ui, 1, 1)) > 1 && wantA == 0) { wantA = 2; }
  uk = "";
  if (go) { return; }
  if (view == 0 && am == 0) { anim(4); } else { draw_head(); draw_bottom(); }
  pump();
}

// 打开卡片上的那个会话：how 1 从待机进去，2 从页面换过去（从右边滑进来）
fn open_card(how) {
  var a = num(sub(uk, 1, 1));
  var s = sub(uk, 2, 4);
  card_next(1);
  dsel = -1;
  drop_pop();
  open_page(a, how, s);
}

// ---------- 目录：第一行是新建会话，下面所有 Agent 的会话按最近动静排；每行一个框，右边是哪个 Agent（新建是麦克风），选中的亮、下面多一行它最后说的话 ----------
// 转表冠时整张表用计时器 0 分三帧竖着滑（和翻历史共用 sy sn），这一帧才露出来的行和选中行的预览淡入

fn draw_dir() {
  if (view != 2 || pop == 1 || am != 0) { return; }
  hide_page(); hide_kids(); show(bl, 0);
  if (wl == 0) { return; }
  var meta = data("i");
  var n = num(sub(meta, 1, 3));
  var st = num(sub(meta, 4, 3));
  if (n == 0) { put(l1, 26, 60, 150, "最近 14 天没有会话"); return; }
  var top = clamp(dsel - 1, 0, max(0, n - 3));
  // 手上的八行不够画这一屏：先去取
  if (top < st || min(top + 3, n) > st + 8) { wl = 0; wantL = 1; pump(); return; }
  // 刚进目录：从下面一点滑上来
  if (fresh && sn == 0) { vlo = -1; vhi = -1; sy = 8; sn = 2; timer(0, 100, 1); }
  var y = 42 + sy;
  var r = 0;
  while (r < 3 && top + r < n) {
    var row = data("d" + str(top + r - st + 1));
    var cur = top + r == dsel;
    var h = 36;
    if (cur) { h = 68; }
    var fe = u1;
    if (r == 1) { fe = u2; } else if (r == 2) { fe = u3; } else if (r == 3) { fe = u4; }
    box(fe, 14, y, 470, min(h, 194 - y));
    var gv = 150;
    if (cur) {
      gv = 255;
      put(l5, 26, y + 34, 150, data("d" + str(top + r - st + 9)));
      if (sn == 2) { anim_opa(l5, 0, 255, 240); }
    }
    put(lel(r + 1), 26, y + 3, gv, sub(row, 6, len(row) - 6));
    var im = agimg(num(sub(row, 0, 1)), cur);
    if (sub(row, 0, 1) == "+") { im = 14; if (cur) { im = 13; } }
    pic(iel(r + 1), 496, y + h / 2 - 10, im);
    if (sn > 0 && (top + r < vlo || top + r > vhi)) { anim_opa(lel(r + 1), 0, 255, 260); anim_opa(iel(r + 1), 0, 255, 260); }
    y += h + 4;
    r += 1;
  }
  vlo = top; vhi = top + r - 1;
  if (n > 3) {
    var bh = clamp(150 * 3 / n, 12, 150);
    box(sb, 533, 42 + (150 - bh) * dsel / max(1, n - 1), 3, bh);
  }
  if (fresh) {
    fresh = 0;
    anim_opa(l1, 0, 255, 240); anim_opa(l2, 0, 255, 240); anim_opa(l3, 0, 255, 240); anim_opa(l4, 0, 255, 240); anim_opa(l5, 0, 255, 240);
    anim_opa(pi1, 0, 255, 240); anim_opa(pi2, 0, 255, 240); anim_opa(pi3, 0, 255, 240); anim_opa(pi4, 0, 255, 240);
  }
}

fn got_dir() {
  var n = num(sub(data("i"), 1, 3));
  if (dsel < 0) { dsel = num(sub(data("i"), 7, 3)); }
  dsel = clamp(dsel, 0, max(0, n - 1));
  wl = 1;
  draw_dir();
}

// 底边正中：麦克风；收起来的弹窗或者翻历史时 Agent 又说了几条，换成一个小胶囊
fn draw_bottom() {
  var t = "";
  if (pop == 2) { t = aname(pa) + " 问你 · 单击查看"; }
  else if (view == 1 && off > 0 && tm > lm) { t = str(tm - lm) + " 条新消息"; }
  else if (view == 1 && cardvis()) {
    t = ut;
    if (num(sub(ui, 1, 1)) > 1) { t = t + "  +" + str(num(sub(ui, 1, 1)) - 1); }
  }
  if ((view == 1 || view == 3) && am == 0 && pop != 1 && t == "") {
    var mi = 14;
    if (view == 1 && sub(fl, 0, 1) == "w" && off == 0) { mi = 13; }
    if (view == 3 && ag != 3) { mi = 13; }
    // 会话在跑：麦克风让到右边，左边写它正在做什么；跑完滑回正中
    var run = view == 1 && off == 0 && sub(fl, 2, 1) == "r";
    var nx = 260;
    if (run) { nx = 506; }
    pic(mic, nx, 174, mi);
    if (mx >= 0 && mx != nx) { anim_x(mic, mx - nx, 0, 300); }
    mx = nx;
    if (run) {
      var a = act;
      if (a == "") { a = "• • •"; }
      put(dots, 18, 175, 150, a);
    } else { show(dots, 0); }
  } else { show(mic, 0); if (view != 0) { show(dots, 0); } }  // 待机时这行小字是更新卡片的提示，归卡片管
  if (t == "" || am != 0) { show(bc, 0); show(bt, 0); bcon = 0; return; }
  // 胶囊只描边，宽度跟着字走（一个汉字 3 字节，大约 15 像素）
  var w = clamp(len(t) * 5 + 40, 120, 440);
  box(bc, 270 - w / 2, 173, w, 22);
  put(bt, 270 - w / 2, 174, 240, t);
  size(bt, w, 20);
  if (!bcon) { anim_opa(bt, 0, 255, 220); bcon = 1; }
}

// ---------- 弹窗：问题在上，下面一行一个能选的 ----------

fn plabel(ch) {
  if (ch == "h") { return "先看历史"; }
  if (ch == "m") { return "说话回答"; }
  if (ch == "a") { return "本会话都允许"; }
  if (ch == "y") { return "允许"; }
  if (ch == "n") { return "拒绝"; }
  var k = num(ch);
  if (k == 1) { return o1; } if (k == 2) { return o2; } if (k == 3) { return o3; } if (k == 4) { return o4; }
  if (k == 5) { return o5; } return o6;
}

fn pimg(ch, hi) {
  var b = 0;
  if (ch == "h") { b = 17; } else if (ch == "m") { b = 13; } else if (ch == "y") { b = 9; } else if (ch == "n") { b = 11; }
  if (b == 0) { return 23; }
  if (hi) { return b; }
  return b + 1;
}

fn hide_kids() {
  show(phd, 0); show(pq1, 0); show(pq2, 0); show(pq3, 0); show(psl, 0); show(l1, 0); show(dots, 0);
  show(po1, 0); show(po2, 0); show(po3, 0); show(po4, 0); show(pi1, 0); show(pi2, 0); show(pi3, 0); show(pi4, 0);
}

fn fade_kids() {
  anim_opa(phd, 0, 255, 220); anim_opa(pq1, 0, 255, 220); anim_opa(pq2, 0, 255, 220); anim_opa(pq3, 0, 255, 220);
  anim_opa(po1, 0, 255, 220); anim_opa(po2, 0, 255, 220); anim_opa(po3, 0, 255, 220); anim_opa(po4, 0, 255, 220);
  anim_opa(pi1, 0, 255, 220); anim_opa(pi2, 0, 255, 220); anim_opa(pi3, 0, 255, 220); anim_opa(pi4, 0, 255, 220);
}

fn draw_pop() {
  if (pop != 1 || am != 0) { return; }
  put(phd, 22, 12, 150, ph);
  put(pq1, 22, 34, 245, p1);
  // 问的话最多三行，选项接在下面；每个选项占 30 像素不挤在一起，放不下的转表冠滚出来
  var oy = 66;
  if (p2 == "") { show(pq2, 0); } else { put(pq2, 22, 56, 245, p2); oy = 88; }
  if (p3 == "") { show(pq3, 0); } else { put(pq3, 22, 78, 245, p3); oy = 106; }
  var vis = 3;
  if (oy == 66) { vis = 4; }
  if (psel < ptop) { ptop = psel; }
  if (psel > ptop + vis - 1) { ptop = psel - vis + 1; }
  var r = 0;
  while (r < 4) {
    var n = ptop + r;
    if (r < vis && n < len(pitems)) {
      var ch = sub(pitems, n, 1);
      var gv = 185;
      if (n == psel) { gv = 255; }
      pic(iel(r + 1), 24, oy + 3 + r * 30, pimg(ch, n == psel));
      put(oel(r + 1), 54, oy + r * 30, gv, plabel(ch));
    } else { show(oel(r + 1), 0); show(iel(r + 1), 0); }
    r += 1;
  }
  box(psl, 14, oy - 3 + (psel - ptop) * 30, 512, 28);
  // 选项放不下时右边一条细的进度条，夹在选中框和外框中间
  var ni = len(pitems);
  if (ni > vis) {
    var bh = 30 * vis * vis / ni;
    box(sb, 529, oy - 3 + (30 * vis - bh) * ptop / (ni - vis), 3, bh);
  } else { show(sb, 0); }
}

// 听写时胶囊往下长出一截，显示听到的话
fn draw_rec() {
  if (rec == 0 || am != 0) { return; }
  var who = "说给 " + aname(ag);
  if (sub(rarg, 0, 1) == "a") { who = "回答 " + aname(pa); }
  else if (sub(rarg, 1, 1) == "n") { who = "新开 " + aname(ag); }
  else if (sub(fl, 1, 1) == "q" && sub(fl, 2, 1) != "i") { who = who + " · 这轮结束后发"; }
  put(phd, 22, 12, 150, who);
  if (heard == "") { put(pq1, 22, 40, 120, "正在听…  单击说完"); } else { put(pq1, 22, 40, 245, heard); }
  show(pq2, 0);
  pic(pi1, 498, 10, 13);
}

// ---------- 过渡：淡入、缩放、横移都交给眼镜本地播（帧率跟屏幕走），脚本只在播完时收一次尾 ----------

fn anim(m) { settle(); am = m; an = 0; step(); }

fn step() {
  if ((am == 1 || am == 2 || am == 9) && an < 3) {
    // 弹窗（1 2）和更新卡片（9）从胶囊的位置长出来。框只描边，缩放、淡入会把它填实，
    // 所以分三帧把框拉大，最后一帧里面的字再淡入
    var y = 4;
    var h = 191;
    if (am == 9) {
      y = 44; h = 88;
      if (p2 != "") { h = 112; }
      if (p3 != "") { h = 136; }
    }
    if (an == 0) {
      hide_kids(); show(bc, 0); show(bt, 0); bcon = 0; show(mic, 0);
      // 透明的框里不能透出下面的页面和页头
      if (am != 9) { hide_page(); hide_head(); }
      box(pbox, 170, y, 200, 34);
    } else if (an == 1) {
      box(pbox, 60, y, 420, (h + 34) / 2);
    } else {
      box(pbox, 6, y, 528, h);
      var m = am;
      am = 0;
      if (m == 9) { draw_head(); anim_opa(l1, 0, 255, 220); } else { draw_pop(); }
      fade_kids();
      am = m;
    }
    an += 1;
    timer(0, 100, 0);
    return;
  }
  if (am == 10) {
    // 进空屏：胶囊里的图标和页面淡出，胶囊的框往中间收两下，然后什么都不留、什么都不跑
    if (an == 0) {
      fade_head(255, 0);
      anim_opa(l1, 255, 0, 200); anim_opa(l2, 255, 0, 200); anim_opa(l3, 255, 0, 200); anim_opa(l4, 255, 0, 200);
      anim_opa(l5, 255, 0, 200); anim_opa(l6, 255, 0, 200); anim_opa(l7, 255, 0, 200);
      anim_opa(e1, 255, 0, 200); anim_opa(e2, 255, 0, 200); anim_opa(bl, 255, 0, 200); anim_opa(mic, 255, 0, 200);
      show(sel, 0); show(hdr, 0); show(u1, 0); show(u2, 0); show(u3, 0); show(u4, 0); show(sb, 0); show(dots, 0);
      show(bc, 0); show(bt, 0); bcon = 0; tt = ""; timer(2, 0, 0);
      box(cap, max(75, hx + 30 + max(0, (len(g) - 2) / 3) * 17) - 69, 9, 138, 24);
    } else if (an == 1) {
      box(cap, max(75, hx + 30 + max(0, (len(g) - 2) / 3) * 17) - 24, 14, 48, 14);
    } else {
      hide_head(); hide_page(); hide_kids(); show(pbox, 0);
      timer(1, 0, 0); timer(2, 0, 0); timer(3, 0, 0);
      qa = -1; wantL = 0; wantA = 0; wantN = 0;
      am = 0;
      // 告诉网关先别往眼镜推；之后一个请求都不发，往下转回来时再问
      cmd(q_act, "zz");
      return;
    }
    an += 1;
    timer(0, 150, 0);
    return;
  }
  if (an > 0) {
    // 收尾
    if (am == 3 || am == 4) { show(pbox, 0); hide_kids(); am = 0; fresh = 1; draw_head(); if (!rec) { draw_page(); } }
    else if (am == 8) { hide_page(); show(bc, 0); show(bt, 0); bcon = 0; wantN = 1; pump(); }
    am = 0;
    draw_bottom();
    return;
  }
  if (am == 3 || am == 4) {
    // 先让框里的字淡出，再撤掉框，下面的页面淡入；3 收成底部的悬浮胶囊，4 收回顶部
    show(psl, 0); show(sb, 0);
    anim_opa(phd, 255, 0, 150); anim_opa(pq1, 255, 0, 150); anim_opa(pq2, 255, 0, 150); anim_opa(pq3, 255, 0, 150); anim_opa(l1, 255, 0, 150);
    anim_opa(po1, 255, 0, 150); anim_opa(po2, 255, 0, 150); anim_opa(po3, 255, 0, 150); anim_opa(po4, 255, 0, 150);
    anim_opa(pi1, 255, 0, 150); anim_opa(pi2, 255, 0, 150); anim_opa(pi3, 255, 0, 150); anim_opa(pi4, 255, 0, 150);
    an = 1;
    timer(0, 160, 0);
    return;
  } else if (am == 5) {
    // 听写：顶部长出一截显示听到的话，页头先藏起来，下面的页面让出这一截
    hide_kids(); hide_head(); show(sb, 0);
    box(pbox, 6, 4, 528, 70);
    am = 0;
    draw_page(); draw_rec();
    anim_opa(phd, 0, 255, 220); anim_opa(pq1, 0, 255, 220); anim_opa(pi1, 0, 255, 220);
    return;
  } else if (am == 8) {
    // 回到待机：页面淡出，胶囊滑回正中
    anim_opa(l1, 255, 0, 200); anim_opa(l2, 255, 0, 200); anim_opa(l3, 255, 0, 200); anim_opa(l4, 255, 0, 200);
    anim_opa(l5, 255, 0, 200); anim_opa(l6, 255, 0, 200); anim_opa(l7, 255, 0, 200);
    anim_opa(e1, 255, 0, 200); anim_opa(e2, 255, 0, 200); anim_opa(bl, 255, 0, 200); anim_opa(mic, 255, 0, 200);
    show(u1, 0); show(u2, 0); show(u3, 0); show(u4, 0); show(dots, 0); show(sb, 0); show(bc, 0); show(bt, 0); bcon = 0;
    draw_head();
  } else { am = 0; return; }
  an = 1;
  timer(0, 240, 0);
}

// ---------- 跳转 ----------

fn drop_pop() { pc = ""; pop = 0; show(pbox, 0); hide_kids(); show(bc, 0); show(bt, 0); bcon = 0; }

// how：0 直接换，1 从待机进来（底边淡入），2 换到下一个 Agent（内容从右边滑进来）
// s：从目录打开时钉住的会话
fn open_page(a, how, s) {
  settle();
  view = 1; ag = a; off = 0; wl = 0; sid = s; tn = 0; tm = 0; lm = 0; fl = ""; ttl = ""; act = ""; mx = -1; fresh = 1;
  if (how == 2) { fresh = 2; }
  hide_page();
  draw_head();
  draw_page();
  if (how == 1) { anim_opa(bl, 0, 255, 320); anim_opa(mic, 0, 255, 320); }
  need_lens();
}

fn to_bottom() {
  settle();
  off = 0;
  fresh = 1;
  draw_page();
  if (wo > 0) { need_lens(); }
}

fn listen(arg) {
  if (!connected()) { toast("手机没连上眼镜"); return; }
  rarg = arg; heard = ""; rec = 1;
  if (pop == 1) { pop = 0; }
  anim(5);
  // 手机停顿约 1.5 秒就结束听写：话一段段先放在网关（- 开头新起一句，. 开头接着说），单击或者第二次停顿才发
  cmd(q_say, "-" + arg);
  timer(2, 700, 1);
}

fn stop_rec() { rec = 0; timer(2, 0, 0); hide_kids(); anim(4); }

fn activate() {
  var ch = sub(pitems, psel, 1);
  if (ch == "h") {
    // 先看历史：页面换到问你的那个会话
    if (view != 1) {
      // 从目录看的回得去目录；从待机、新开看的不回
      if (view == 2) { dsel = max(0, dsel); } else { dsel = -1; }
      var keep = pc; drop_pop(); pc = keep; pop = 2; wantL = 3; open_page(pa, 1, ""); return;
    }
    pop = 2; anim(3);
    if (pa == ag) { wantL = 3; pump(); }
    return;
  }
  if (ch == "m") { listen("a" + pid); return; }
  pop = 0;
  anim(4);
  cmd(q_act, pid + ch);
  toast("处理中…");
}

// ---------- 网关回复 ----------

fn got_k(nk) {
  if (nk == "") {
    if (pc != "") { pc = ""; if (pop == 1) { pop = 0; anim(4); } else if (pop == 2) { pop = 0; draw_bottom(); } }
    return;
  }
  if (nk == pc) { return; }
  pc = nk; pa = num(sub(nk, 1, 1)); pid = sub(nk, 2, 4);
  wantA = 1;
  pump();
}

fn got_now() {
  g = data("g");
  var nv = data("v");
  var n = max(0, (len(g) - 2) / 3);
  var ns = num(sub(nv, 3 + n * 2, 8));
  // 有会话说了新的话：去取下一张更新卡片。刚打开或者网关重启过，从现在算起
  if (ucur < 0 || ns < ucur) { ucur = ns; }
  else if (ns > ucur && uk == "" && wantA == 0 && pop == 0 && rec == 0 && (view == 0 || view == 1)) { wantA = 2; }
  // 目录：哪个 Agent 有了动静都重新读；页面：这个 Agent 的版本变了才读
  if (view == 2 && sub(nv, 0, 2 + n * 2) != sub(v, 0, 2 + n * 2)) { wantL = 1; }
  var vp = 0;
  if (ag != 5) { vp = 2 + slotof(ag) * 2; }
  if (view == 1 && sub(nv, vp, 2) != sub(v, vp, 2)) { wantL = 1; }
  v = nv;
  got_k(data("st"));  // 有事等你的代码存在 st 里，数据表省下一个键给 _err
  draw_head();
  pump();
}

fn got_lens() {
  var meta = data("i");
  if (sub(meta, 0, 1) == "D") { if (view == 2) { got_dir(); } return; }
  if (view != 1) { return; }
  var ntn = num(sub(meta, 3, 3));
  var ntm = num(sub(meta, 6, 3));
  var nsid = sub(meta, 12, 4);
  // 最新一条回复的第一行离最新几行时，正好摆在页面最上面（网关算好）；0 = 一屏放得下
  var head = num(sub(meta, 16, 3));
  fl = sub(meta, 0, 3); wo = num(sub(meta, 9, 3)); act = sub(meta, 19, 44);
  ttl = data("h"); g = data("g"); v = data("v");
  wl = 0;
  while (wl < 16 && data("d" + str(wl + 1)) != "") { wl += 1; }
  wl = min(wl, max(0, ntn - wo));
  if (nsid != sid) {
    // Agent 自己开了新会话：回到最底下，内容淡入
    // 钉住的会话不在了才会自己换；换 Agent 换过去的从右边滑进来
    if (sid != "" && fresh != 2) { toast("换到新会话"); }
    if (fresh != 2) { fresh = 1; }
    settle(); sid = nsid; off = head; lm = ntm;
  } else if (off > 0) {
    off += ntn - tn;
  } else if (tn == 0 || ntm > tm) {
    // 刚打开，或者跟着最底下时来了新消息：长回复从它的第一行看起，往下转接着读
    off = head; lm = ntm;
  }
  tn = ntn; tm = ntm;
  off = clamp(off, 0, max(0, tn - 1));
  draw_head();
  if (pop != 1) { draw_page(); }
}

fn got_ask() {
  var nk = data("st");
  var inf = data("i");
  // 这次回复写在了行用的键上：页面、目录先不重画，马上重新取
  if (view == 1 || view == 2) { wl = 0; need_lens(); }
  if (sub(inf, 0, 1) == "U") {
    // 更新卡片；没有了就跳到最新那条
    if (nk == "") { ucur = max(ucur, num(sub(inf, 2, 8))); return; }
    if (pop != 0 || rec) { return; }
    uk = nk; ui = inf; uat = now();
    ph = data("h"); p1 = data("d1"); p2 = data("d2"); p3 = data("d3"); ut = data("d4");
    if (view == 0 && am == 0) { anim(9); } else { draw_bottom(); }
    return;
  }
  if (nk == "") { got_k(""); return; }
  // 问题和卡片共用这几行字：手上的卡片先放下，问完再取
  uk = "";
  ph = data("h"); p1 = data("d1"); p2 = data("d2"); p3 = data("d3");
  o1 = data("d4"); o2 = data("d5"); o3 = data("d6"); o4 = data("d7"); o5 = data("d8"); o6 = data("d9");
  if (sub(pc, 0, 1) == "i") {
    pitems = "h" + sub("123456", 0, num(sub(inf, 0, 1)));
    if (sub(inf, 2, 1) == "1") { pitems = pitems + "m"; }
  } else {
    pitems = "h";
    if (sub(inf, 1, 1) == "1") { pitems = pitems + "a"; }
    if (sub(inf, 2, 1) == "1") { pitems = pitems + "y"; }
    pitems = pitems + "n";
  }
  psel = 0; ptop = 0;
  if (rec) { return; }
  if (pop == 2) { draw_bottom(); return; }
  // 待机、或者正看着这个 Agent 的最底下：直接弹出来；别的时候先收成底部的胶囊，单击再看
  if (view == 0 || (view == 1 && off == 0 && pa == ag)) { pop = 1; anim(1); } else { pop = 2; draw_bottom(); }
}

fn got_cmd(e) {
  var st = data("st");
  // rec 1 在听  3 停顿后接着听、还没听到字  2 说完了（单击过，或者第二轮没听到），等网关把这句话发出去
  if (rec && kCmd == q_say && (e == "empty" || (e == "" && st == "held"))) {
    if (e == "") { heard = data("h"); }
    if (rec != 2 && e == "") { rec = 3; cmd(q_say, "." + rarg); } else { rec = 2; heard = "说完了，发送中…"; cmd(q_act, "-" + rarg); }
    draw_rec();
    return;
  }
  if (kCmd == q_say || rec) {
    if (rec) { stop_rec(); }
    if (e != "" || st == "stopped" || st == "fail" || st == "busy" || st == "empty") {
      // 没答上的问题收成底部胶囊，还能再点开
      if (sub(rarg, 0, 1) == "a" && pc != "") { pop = 2; draw_bottom(); }
    }
    if (e == "empty") { toast("没听到"); return; }
    if (e == "busy") { toast("麦克风正忙"); return; }
    if (e != "") { toast("没发出去"); return; }
    if (st == "stopped" || st == "held") { return; }
    toast(data("h"));
    // 新开的会话开起来了：进这个 Agent 的页面，最新的就是它
    if (view == 3 && st == "sent") { dsel = -1; open_page(ag, 1, ""); return; }
    if (st != "fail" && st != "ro" && st != "empty") { settle(); off = 0; need_lens(); }
    return;
  }
  if (kCmd == q_act) {
    if (e != "") { toast("没成功，请到电脑上看"); pop = 2; draw_bottom(); return; }
    toast(data("h"));
    if (st != "ok" && st != "gone") { pop = 2; draw_bottom(); }
    if (view == 1) { need_lens(); } else { wantN = 1; pump(); }
  }
}

fn problem(e) {
  if (e == "noagent") { toast("没接 Agent：到 Spare App 开发者设置接入 Relay"); }
  else if (e == "auth") { toast("Token 不对，检查 Spare App 里填的"); }
  else if (e == "net") { toast("连不上 Mac，看网关和隧道"); }
  else if (e == "perm") { toast("缺少权限，重新安装这个应用"); }
  else { toast("出错了"); }
}

on data(seq) {
  // 空屏：推送和回复都不看
  if (view == 4) { return; }
  var e = data("_err");
  if (seq == 0) {
    // 听写进度和网关推送都走序号 0
    // 第二轮听到字了：这一轮交给手机自己按停顿结束
    if (rec) { if (data("st") == "rec" && data("tx") != "") { heard = data("tx"); if (rec == 3) { rec = 1; } draw_rec(); } return; }
    if (e == "" && data("g") != "") { got_now(); }
    return;
  }
  if (seq == sNow) { sNow = 0; if (e == "") { got_now(); } else if (g == "") { problem(e); } return; }
  if (seq == sLens) { sLens = 0; if (e == "") { got_lens(); } else { problem(e); } return; }
  if (seq == sAsk) { sAsk = 0; if (e == "") { got_ask(); } return; }
  // 说的话要等录音结束手机才发出去，按回复到达的时间算这次请求，免得紧接着读页被手机限频拦下
  if (seq == sCmd) { sCmd = 0; if (kCmd == q_say) { last = now(); } got_cmd(e); }
}

// ---------- 手势 ----------

on open() {
  view = 0; ag = 0; off = 0; wl = 0; pop = 0; pc = ""; rec = 0; am = 0; tt = ""; v = ""; g = ""; ucur = -1; uk = "";
  hx = -1;
  qa = -1; wantL = 0; wantA = 0; wantN = 0;
  hide_page(); hide_kids(); show(pbox, 0); show(bc, 0); show(bt, 0);
  draw_head();
  if (connected()) { wantN = 1; pump(); } else { toast("等待连接：手机没连上眼镜"); }
  timer(1, 1000, 1);
}

on close() { timer(0, 0, 0); timer(1, 0, 0); timer(2, 0, 0); timer(3, 0, 0); }

on crown(d) {
  if (rec) { cmd(q_mic, "stop"); stop_rec(); return; }
  if (pop == 1) {
    psel = clamp(psel + d, 0, len(pitems) - 1);
    draw_pop();
    return;
  }
  if (view == 4) {
    // 空屏：往下转回到待机，往上转进总管（它的底部再往下转回空屏）
    if (am != 0) { return; }
    view = 0; sNow = 0; sLens = 0; sAsk = 0; sCmd = 0;
    timer(1, 1000, 1);
    if (d < 0) { dsel = -3; open_page(5, 1, ""); } else { draw_head(); wantN = 1; pump(); }
    fade_head(0, 255);
    return;
  }
  if (view == 0 && cardvis()) {
    // 待机露着更新卡片：转表冠看下一张，最后一张就收起
    if (am == 0) { card_next(0); }
    return;
  }
  if (view == 2) {
    // 目录：转表冠选；在第一个再往上转回到待机
    if (d < 0 && dsel <= 0) { view = 0; dsel = -1; drop_pop(); anim(8); return; }
    if (wl == 0) { return; }
    var od = dsel;
    dsel = clamp(dsel + d, 0, max(0, num(sub(data("i"), 1, 3)) - 1));
    if (dsel == od) { return; }
    settle(); sy = d * 8; sn = 2;
    draw_dir();
    timer(0, 100, 1);
    return;
  }
  if (view == 3) {
    // 新开：往上转选下一个启用的 Agent，在第一个上往下转回到待机
    if (am != 0) { return; }
    var os = slotof(ag);
    if (d > 0 && os <= 0) { view = 0; drop_pop(); anim(8); return; }
    var ns = clamp(os - d, 0, max(0, (len(g) - 2) / 3) - 1);
    if (ns == os) { return; }
    ag = who(ns);
    draw_head(); draw_bottom();
    anim_x(sel, (os - ns) * 34, 0, 220);
    return;
  }
  if (d < 0) {
    if (view == 0) {
      // 待机往上转：进空屏
      if (am != 0) { return; }
      view = 4; drop_pop(); anim(10);
      return;
    }
    var mx = max(0, tn - 4);
    if (off >= mx) { return; }
    var was = off;
    if (off == 0) { lm = tm; }
    off = min(mx, off + 2);
    glide(was);
    if (was == 0) { anim_opa(sb, 0, 255, 220); }
    if (off + 8 > wo + wl && wo + wl < tn) { need_lens(); }
    return;
  }
  // 往下：翻回最新；到底以后停一下再转，才离开这一页
  var t = now();
  var gap = t - downAt;
  downAt = t;
  if (view == 1 && off > 0) {
    var fo = off;
    off = max(0, off - 2);
    glide(fo);
    if (off < wo) { need_lens(); }
    return;
  }
  if (gap < 300 || am != 0) { return; }
  // 待机往下转：进总管
  if (view == 0) { dsel = -1; drop_pop(); open_page(5, 1, ""); return; }
  // 从空屏进的总管：回空屏
  if (dsel == -3) { view = 4; drop_pop(); anim(10); return; }
  if (dsel >= 0) {
    // 从目录打开的：回到目录，落在刚才这个会话上
    settle(); drop_pop(); view = 2; dsel = -2; wl = 0; fresh = 1;
    hide_page(); show(bl, 0); draw_head(); draw_bottom();
    wantL = 4; pump();
    return;
  }
  // 总管、卡片或者问题打开的页面：回到待机
  view = 0; drop_pop(); anim(8);
}

on click() {
  if (view == 4) { return; }
  if (rec == 2) { return; }
  // 两段之间还没接着听的时候单击：直接让网关发
  if (rec) { if (qa == q_say) { cmd(q_act, "-" + rarg); } else { cmd(q_mic, "end"); } rec = 2; heard = "说完了，发送中…"; draw_rec(); return; }
  if (am != 0) { return; }
  if (pop == 1) { activate(); return; }
  if (view == 0) {
    if (cardvis()) { open_card(1); return; }
    // 打开目录
    view = 2; dsel = 0; off = 0; wl = 0; fresh = 1; drop_pop(); hide_page();
    draw_head(); draw_bottom();
    need_lens();
    return;
  }
  if (pop == 2) { pop = 1; anim(2); return; }
  if (view == 2) {
    if (wl == 0) { return; }
    var row = data("d" + str(dsel - num(sub(data("i"), 4, 3)) + 1));
    if (row == "") { return; }
    hide_kids();
    if (sub(row, 0, 1) == "+") {
      // 新建会话：往上转选 Agent，单击说话；在第一个上往下转回到待机
      if (who(0) < 0) { toast("到 Mac 上运行 relay setup"); return; }
      settle(); view = 3; ag = who(0); off = 0; dsel = -1; drop_pop(); hide_page();
      draw_head(); draw_bottom(); anim_opa(mic, 0, 255, 320);
      return;
    }
    open_page(num(sub(row, 0, 1)), 1, sub(row, 2, 4));
    return;
  }
  if (view == 3) {
    if (ag == 3) { toast("Grok 暂不支持从眼镜新开"); return; }
    listen(letter(ag) + "n");
    return;
  }
  if (off > 0) { to_bottom(); return; }
  if (cardvis()) { open_card(2); return; }
  if (fl == "") { toast("还在读这个会话"); return; }
  // 说的话发给屏幕上这个会话，不管说完时 Agent 哪个会话更新
  var la = letter(ag);
  if (sid != "") { la = la + "s" + sid; }
  if (sub(fl, 0, 1) == "w") { listen(la); } else { toast("这个会话只能看"); }
}

on timer(id) {
  if (id == 0) {
    if (sn > 0) {
      // 最后一帧也算在滑，这一帧才露出来的行照样淡入
      if (sn == 1) { ds = 0; sy = 0; draw_page(); settle(); } else { sn -= 1; sy = sy * 4 / 11; draw_page(); }
      return;
    }
    timer(0, 0, 0);
    step();
  } else if (id == 1) {
    // 每秒一次：等你的 Agent 图标淡一下再亮回来；卡片露满 6 秒换下一张（被挡住的时候不算）；4 秒没跟网关说过话就问一次状态
    // 空屏时这个计时器停了，所以不闪
    // 第二轮手机可能一直等人开口：约一秒半没听到字，眼镜自己结束这一轮，网关把攒下的话发出去
    if (rec == 3 && now() - last >= 1400) { rec = 1; cmd(q_mic, "end"); }
    // 总管页的时间和电量每分钟换一次
    if (view == 1 && ag == 5 && am == 0 && seconds() < 2) { draw_head(); }
    if (pop != 1 && !rec) {
      var i = 0;
      while (who(i) >= 0) { if (sub(g, 3 + i * 3, 1) == "w") { anim_opa(ael(i), 70, 255, 800); } i += 1; }
    }
    if (uk != "") { if (!cardvis() || am != 0) { uat = now(); } else if (now() - uat >= 6000) { card_next(0); } }
    if (!connected() || rec || now() - last < 4000) { return; }
    wantN = 1;
    pump();
  } else if (id == 2) {
    if (rec) { anim_opa(pi1, 255, 70, 650); return; }
    timer(2, 0, 0);
    tt = "";
    draw_head();
  } else if (id == 3) {
    pump();
  }
}
