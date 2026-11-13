#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
My Economic 流水统一解析器
=============================
把多个银行/支付流水文件统一解析成标准 CSV，做跨文件去重，标注跨来源疑似重复。

支持的来源
  - 微信支付 xlsx（可分大号 / 小号）
  - 支付宝 csv（可分多个账号）
  - 招商银行 pdf（需为电子流水，非扫描件）
  - 邮储银行 pdf（需为电子流水，非扫描件）

只读输入；只往 <程序目录>/_tmp_import/ 写文件；不装依赖；不联网；不碰数据库。

标准字段（与项目既有定义一致）
  transaction_time,type,category_level1,category_level2,category,amount,currency,
  transaction_object,account,target_account,participant,note
  - amount 恒为正数（元）；方向由 type 决定（支出/收入/转账）
  - 分类一律留空，由用户后续确认

用法
  python 解析流水.py                # 正常跑
  python 解析流水.py --no-bank-diag # 跳过 PDF 坐标诊断输出
"""
from __future__ import annotations

import collections
import csv
import hashlib
import os
import json
import re
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

# ----------------------------------------------------------------------------
# 路径与常量
# ----------------------------------------------------------------------------
SRC_ROOT = Path(os.environ.get("BILL_IMPORT_DIR")
                or (Path(__file__).resolve().parent.parent / "账单导入"))
OUT_ROOT = Path(os.environ.get("BILL_IMPORT_OUT") or (Path(__file__).resolve().parent.parent / "_tmp_import"))
SKILL_SCRIPTS = Path(__file__).resolve().parent

STANDARD_FIELDS = [
    "transaction_time", "type", "category_level1", "category_level2", "category",
    "amount", "currency", "transaction_object", "account", "target_account",
    "participant", "note",
]
# 合并总表在标准字段后追加追踪列（便于追溯与去重审计）
TRACE_FIELDS = ["source_kind", "source_file", "uid", "flag", "dup_kind"]

# 账户映射
# 口径（通用）：同一个人可能有两个支付宝账号绑定同一张银行卡、资金池相同，
#   账本里不分开记 → 两者流水可并入同一个支付宝账户，不新建第二个账户。
#   招商银行账户由用户自己在看板里手动新建，脚本不自动创建。
#
# ⚠️ 账户名一律由环境变量提供（写在 local-paths.cmd 里，该文件不进仓库），
#    代码里只保留通用默认名 —— 否则别人用这套程序会串到原作者的账户名上。
def _acc(env_key, default):
    return os.environ.get(env_key) or default

ACC_RELATIVE = _acc("BILL_ACC_RELATIVE", "亲属卡")
ACC_WX_MAIN  = _acc("BILL_ACC_WX_MAIN",  "微信大号")
ACC_WX_SUB   = _acc("BILL_ACC_WX_SUB",   "微信小号")
ACC_ALIPAY   = _acc("BILL_ACC_ALIPAY",   "支付宝")
ACC_ALIPAY_177 = ACC_ALIPAY            # 兼容旧名（两个支付宝账号并入同一账户）
ACC_PSBC     = _acc("BILL_ACC_PSBC",     "邮储卡")
ACC_CMB      = _acc("BILL_ACC_CMB",      "招商银行")

# 支付宝第二个账号在导出文件名里的标记（真实号码片段只写在 local-paths.cmd）
_AP_MARK_B = os.environ.get("BILL_ALIPAY_OWNER_B_MARK") or "B"


def alipay_owner_key(text):
    # 按支付宝账单文件名判定账号归属，返回 "A" / "B"。
    # 判定语义与改造前完全一致（只看传入文本里有没有第二个账号的标记），
    # 区别只是把硬编码的手机号片段换成了环境变量。
    return "B" if _AP_MARK_B and _AP_MARK_B in str(text or "") else "A"


# 银行卡付款方式 → 本地账户（微信/支付宝账单里的"支付方式"字段）
# 键是账单里的原始文本，含银行卡号尾号；尾号同样来自环境变量，代码里不写死卡号。
BANK_PAY_MAP = {
    "邮储银行储蓄卡(%s)" % (os.environ.get("BILL_PSBC_CARD_TAIL") or "尾号"): ACC_PSBC,
    "招商银行储蓄卡(%s)" % (os.environ.get("BILL_CMB_CARD_TAIL") or "尾号"): ACC_CMB,
}

# 银行流水来源标识（与支付平台区分：平台记录也可能挂银行账户，但它不是银行流水本身）
BANK_SOURCES = {"邮储银行", "招商银行"}

# 银行侧账户 → 用于跨来源配对的银行标识
BANK_ACCOUNTS = {ACC_PSBC, ACC_CMB}

# 微信里指向"亲属卡"的付款方式
RELATIVE_PAY_KEYS = {"亲属卡"}
RELATIVE_PAY_PREFIX = "亲属卡"   # 付款方式可能带后缀（如「亲属卡(姓名)」），按前缀匹配

# 跨来源配对允许的时间差（秒）。平台记录与银行扣款几乎同时发生。
CROSS_WINDOW_SEC = 180


# ----------------------------------------------------------------------------
# 通用工具
# ----------------------------------------------------------------------------
def money(text) -> int | None:
    """把金额文本转成"分"（int）。支持千分位、正负号、￥。返回 None 表示无法解析。"""
    if text is None:
        return None
    s = str(text).strip()
    if not s or s in {"/", "-", "—"}:
        return None
    s = s.replace("￥", "").replace("¥", "").replace(",", "").replace("元", "").strip()
    if not s:
        return None
    try:
        d = Decimal(s)
    except Exception:
        return None
    return int((d * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def cents_to_str(cents: int | None) -> str:
    if cents is None:
        return ""
    return f"{Decimal(abs(cents)) / 100:.2f}"


def norm_space(text) -> str:
    return re.sub(r"\s+", "", str(text or "")).strip()


def clean(text) -> str:
    """清洗单元格：去首尾空白、制表符；'/' 视为空。"""
    s = str(text if text is not None else "").strip().strip("\t").strip()
    return "" if s in {"/", "-", ""} else s


def norm_time(raw) -> str:
    """把各种时间写法规范成 YYYY-MM-DD HH:MM:SS。拿不到时分秒时补 00:00:00。"""
    if raw is None:
        return ""
    if hasattr(raw, "strftime"):
        return raw.strftime("%Y-%m-%d %H:%M:%S")
    s = str(raw).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?", s)
    if not m:
        return ""
    y, mo, d, hh, mm, ss = m.groups()
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d} {int(hh or 0):02d}:{int(mm or 0):02d}:{int(ss or 0):02d}"


def uid_hash(*parts) -> str:
    """无原生单号时，用字段组合生成稳定的短哈希作为去重键。"""
    base = "|".join(str(p) for p in parts)
    return "H" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def make_rec(**kw) -> dict:
    """构造一条标准记录。"""
    rec = {f: "" for f in STANDARD_FIELDS}
    rec.update(kw)
    for f in TRACE_FIELDS:
        rec.setdefault(f, "")
    return rec


# ----------------------------------------------------------------------------
# 账户标识提取
# ----------------------------------------------------------------------------
# 账单里本来就带着"这笔钱属于谁"的标识，以前只当元数据丢掉：
#   微信 xlsx  第 2 行「微信昵称：[xxx]」
#   支付宝 csv 导出信息「支付宝账户：1xx...」
#   银行 PDF   首页「卡号/账号：...」「户名：...」
# 现在用它们来决定账单记录该落到哪个本地账户（解析阶段的标识 → 预览阶段的
# 账户建议 → 执行阶段按用户确认的映射重写 account）。
#
# 匹配规则（从稳到松）：exact → fuzzy → 同源主账户兜底 → none。
# 兜底用的仍然是环境变量常量（BILL_ACC_*），所以老用户的 local-paths.cmd
# 配置依然有效，行为不会突然改变。
ACCOUNT_HINT_WECHAT = "微信昵称"
ACCOUNT_HINT_ALIPAY = "支付宝账户"
ACCOUNT_HINT_BANK = "银行卡"

_WX_NICK_RE = re.compile(r"微信昵称[:：]\s*\[([^\]]+)\]")
_AP_ACCOUNT_RE = re.compile(r"支付宝账户[:：]\s*([0-9A-Za-z@.\-_]{6,40})")
_AP_NAME_RE = re.compile(r"^姓名[:：]\s*(\S{1,20})$")
_BANK_CARD_RE = re.compile(r"(?:卡号/账号|卡号|账号)[:：]\s*([0-9*]{6,32})")
# 户名后面紧跟着别的字段（招行「户名：X账号：Y」、邮储「户名：X起止日期：Z」），
# 所以必须用后续标签做右边界，否则会把「户名起止日期」整串吃进来。
_BANK_OWNER_RE = re.compile(
    r"户名[:：]\s*([^\s:：*]{2,20}?)(?=账号|卡号|起止日期|开户行|开户|账户|$|\s)")
# 银行名 → 归一化简称（用于和本地账户名做模糊匹配）
_BANK_NAME_KEYS = (
    ("中国邮政储蓄银行", "邮储银行"), ("邮政储蓄", "邮储银行"),
    ("邮储", "邮储银行"), ("邮政", "邮储银行"),
    ("招商银行", "招商银行"), ("招商", "招商银行"),
)


def mask_account(value) -> str:
    """账号脱敏：前 3 位 + **** + 后 4 位；已经是脱敏形态或太短就原样返回。"""
    s = norm_space(value)
    if not s:
        return ""
    if "*" in s:
        return s
    digits = re.sub(r"\D", "", s)
    if len(digits) < 8:
        return s
    return "%s****%s" % (digits[:3], digits[-4:])


def card_tail(value) -> str:
    """卡号末 4 位数字，用于拼「尾号1234」这种短标识。"""
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[-4:] if len(digits) >= 4 else ""


def wechat_identifier(path: Path) -> dict:
    """读微信 xlsx 表头之前的元数据行，取「微信昵称：[xxx]」。"""
    found = ""
    try:
        from openpyxl import load_workbook
        wb = load_workbook(path, read_only=True, data_only=True)
        try:
            sheet = wb.active
            for index, row in enumerate(sheet.iter_rows(values_only=True), start=1):
                for cell in row:
                    text = str(cell or "")
                    if "微信昵称" not in text:
                        continue
                    m = _WX_NICK_RE.search(norm_space(text))
                    if m:
                        found = m.group(1).strip()
                        break
                if found or index > 12:   # 昵称固定在前几行，扫过头就停
                    break
        finally:
            wb.close()
    except Exception:
        pass
    return {"identifier": found, "hint": ACCOUNT_HINT_WECHAT}


def alipay_identifier(path: Path) -> dict:
    """读支付宝 csv 导出信息段（表头之前的行），取账户与姓名。"""
    out = {"identifier": "", "hint": ACCOUNT_HINT_ALIPAY, "owner_name": ""}
    try:
        data = Path(path).read_bytes()
        text = ""
        for enc in ("gb18030", "utf-8-sig", "utf-8"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = data.decode("gb18030", errors="replace")
        for line in text.splitlines()[:20]:
            s = line.strip()
            if not out["identifier"]:
                m = _AP_ACCOUNT_RE.search(s)
                if m:
                    out["identifier"] = mask_account(m.group(1))
                    continue
            if not out["owner_name"]:
                m = _AP_NAME_RE.match(s)
                if m:
                    out["owner_name"] = m.group(1)
            if out["identifier"] and out["owner_name"]:
                break
    except Exception:
        pass
    return out


def bank_identifier(path: Path, bank_hint: str = "") -> dict:
    """读银行 PDF 首页抬头，取卡号尾号与户名。"""
    out = {"identifier": "", "hint": ACCOUNT_HINT_BANK, "bank_name": bank_hint,
           "owner_name": "", "card_tail": ""}
    try:
        import pymupdf
        lines = []
        doc = pymupdf.open(path)
        try:
            for pno in range(min(2, doc.page_count)):
                for _yc, ws in pdf_rows(doc[pno]):
                    lines.append(join_words(ws))
        finally:
            doc.close()
        head = "\n".join(lines[:40])
        m = _BANK_CARD_RE.search(head)
        if m:
            tail = card_tail(m.group(1))
            if tail:
                out["card_tail"] = tail
                out["identifier"] = "尾号%s" % tail
        m = _BANK_OWNER_RE.search(head)
        if m:
            out["owner_name"] = m.group(1)
        if not out["bank_name"]:
            for key, name in _BANK_NAME_KEYS:
                if key in head:
                    out["bank_name"] = name
                    break
    except Exception:
        pass
    return out


# 来源 → 统一的 source_kind 分类（账户标识按这个维度归组与展示）
SOURCE_GROUP = {
    "微信支付": "wechat",
    "支付宝": "alipay",
    "招商银行": "bank",
    "邮储银行": "bank",
}


def suggested_default_name(hint: str, identifier: str, bank_name: str = "") -> str:
    """匹配不到本地账户时，用「hint + 标识」拼一个可读的默认账户名。"""
    ident = str(identifier or "").strip()
    if not ident:
        return ""
    if hint == ACCOUNT_HINT_WECHAT:
        return "微信%s" % ident
    if hint == ACCOUNT_HINT_ALIPAY:
        return "支付宝%s" % ident
    if hint == ACCOUNT_HINT_BANK:
        return "%s%s" % (bank_name or "银行卡", ident)
    return ident


def identifier_tokens(identifier: str, hint: str, bank_name: str = "") -> list[str]:
    """把标识拆成可用于模糊匹配的候选片段，长的（更可信）排前面。"""
    ident = str(identifier or "").strip()
    tokens = []
    if ident:
        tokens.append(ident)
    if hint == ACCOUNT_HINT_BANK:
        tail = card_tail(ident)
        if tail:
            tokens.append(tail)
        if bank_name:
            tokens.append(bank_name)
            if "银行" in bank_name:
                tokens.append(bank_name.replace("银行", ""))
    elif hint == ACCOUNT_HINT_ALIPAY:
        # 支付宝账号只看末 4 位：避免「账号B」误命中历史上遗留的另一个支付宝账户，
        # 多个支付宝账号按既有口径并入同一个资金池，不新建第二个账户。
        tail = card_tail(ident)
        if tail:
            tokens.append(tail)
    # 去重并保持顺序，太短的片段不参与匹配（容易误伤）
    seen, out = set(), []
    for t in tokens:
        t = str(t or "").strip()
        if len(t) >= 2 and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def match_local_account(identifier: str, hint: str, accounts, bank_name: str = "",
                        fallback: str = "") -> dict:
    """把一个账单账户标识匹配到本地账户名。

    返回 {"suggested_local", "match_type", "reason"}：
      exact  —— 本地账户名与标识完全相等
      fuzzy  —— 本地账户名包含标识片段，或标识包含本地账户名的关键部分
      none   —— 匹配不到，suggested_local 为 None（由前端建议新建）

    支付宝特例：账号是纯数字串，若允许「标识包含账户名关键部分」的反向匹配，
    脱敏账号会误命中历史遗留的另一个支付宝账户。而既有口径是多个支付宝
    账号资金池相同、并入同一个账户（不新建第二个支付宝账户），所以支付宝只走
    正向匹配 + 同源主账户兜底，确保导入行为与改造前完全一致。
    """
    ident = str(identifier or "").strip()
    names = [str(n).strip() for n in (accounts or []) if str(n or "").strip()]
    if not ident or not names:
        return {"suggested_local": None, "match_type": "none", "reason": "没有标识或本地无账户"}

    # 1) 完全相等
    for name in names:
        if name == ident:
            return {"suggested_local": name, "match_type": "exact", "reason": "账户名与标识完全一致"}

    # 2) 模糊：本地账户名包含标识片段
    tokens = identifier_tokens(ident, hint, bank_name)
    best = ""
    best_len = 0
    for name in names:
        for tok in tokens:
            if tok and tok in name and len(tok) > best_len:
                best, best_len = name, len(tok)
                break
    if best:
        return {"suggested_local": best, "match_type": "fuzzy",
                "reason": "本地账户名包含标识片段「%s」" % next(
                    (t for t in tokens if t in best), ident)}

    # 3) 模糊：标识包含本地账户名的关键部分（去掉通用前缀后比对）
    if hint != ACCOUNT_HINT_ALIPAY:
        for name in names:
            core = re.sub(r"^(微信|支付宝|邮储|招商|银行卡|银行)", "", name).strip(" -_")
            if len(core) >= 2 and core in ident:
                return {"suggested_local": name, "match_type": "fuzzy",
                        "reason": "标识包含本地账户名关键部分「%s」" % core}

    # 4) 同源主账户兜底：支付宝两个账号资金池相同，按既有口径并入同一账户
    if fallback and fallback in names:
        return {"suggested_local": fallback, "match_type": "fuzzy",
                "reason": "自动匹配不到，按同源主账户兜底（BILL_ACC_* 常量）"}

    return {"suggested_local": None, "match_type": "none", "reason": "本地没有相近账户"}


def build_account_suggestions(identifier_files, accounts) -> list[dict]:
    """把「每个文件的账户标识」聚合成按标识分组的账户建议列表。"""
    names = [str(n).strip() for n in (accounts or []) if str(n or "").strip()]
    groups = collections.OrderedDict()
    for item in identifier_files or []:
        ident = str(item.get("identifier") or "").strip()
        if not ident:
            continue
        key = (item.get("source_kind") or "", ident)
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "identifier": ident,
                "hint": item.get("hint") or "",
                "source_kind": item.get("source_kind") or "",
                "bank_name": item.get("bank_name") or "",
                "owner_name": item.get("owner_name") or "",
                "entry_count": 0,
                "files": [],
                "subject_accounts": [],
            }
        g["entry_count"] += int(item.get("entry_count") or 0)
        if item.get("file") and item["file"] not in g["files"]:
            g["files"].append(item["file"])
        subj = item.get("subject_account") or ""
        if subj and subj not in g["subject_accounts"]:
            g["subject_accounts"].append(subj)
        if not g["bank_name"] and item.get("bank_name"):
            g["bank_name"] = item["bank_name"]

    out = []
    for g in groups.values():
        fallback = ""
        if g["source_kind"] == "alipay":
            fallback = ACC_ALIPAY
        elif g["source_kind"] == "wechat":
            fallback = g["subject_accounts"][0] if g["subject_accounts"] else ""
        elif g["source_kind"] == "bank":
            fallback = g["subject_accounts"][0] if g["subject_accounts"] else ""
        m = match_local_account(g["identifier"], g["hint"], names,
                               bank_name=g["bank_name"], fallback=fallback)
        out.append({
            "identifier": g["identifier"],
            "hint": g["hint"],
            "source_kind": g["source_kind"],
            "bank_name": g["bank_name"],
            "owner_name": g["owner_name"],
            "entry_count": g["entry_count"],
            "files": g["files"],
            "suggested_local": m["suggested_local"],
            "match_type": m["match_type"],
            "match_reason": m["reason"],
            # 即使匹配到了现有账户，也照样给一个「新建：xxx」备选，
            # 让用户可以在下拉里主动改成新建一个账户（前端用去重保护避免重名）
            "suggested_new": suggested_default_name(
                g["hint"], g["identifier"], g["bank_name"]),
            "existing_accounts": names,
        })
    # 条数多的排前面，方便用户先看大头
    out.sort(key=lambda x: (-int(x.get("entry_count") or 0), str(x.get("identifier") or "")))
    return out


def normalize_account_mapping(value) -> dict:
    """把前端传回来的 account_mapping 洗成 {标识: 账户名}，丢掉空值。"""
    if not isinstance(value, dict):
        return {}
    out = {}
    for k, v in value.items():
        key = str(k or "").strip()
        val = str(v or "").strip()
        if key and val:
            out[key] = val
    return out


# ----------------------------------------------------------------------------
# 微信 xlsx —— 优先复用项目既有解析函数
# ----------------------------------------------------------------------------
def _load_wechat_module():
    if str(SKILL_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SKILL_SCRIPTS))
    import import_wechat_bill as W  # noqa
    return W


def wx_account(pay_method: str, nickname_key: str) -> str:
    """
    微信账单的 account = 按"支付方式"映射到本地账户（与项目既有 import_wechat_bill 思路一致）。
      - 亲属卡 / 亲属卡(任意后缀)      -> 亲属卡
      - 邮储银行储蓄卡(卡号尾号)      -> 邮储卡     （跨来源重复来源）
      - 招商银行储蓄卡(卡号尾号)      -> 招商银行   （跨来源重复来源）
      - 零钱 / 空 / '/'               -> 按来源：大号=微信大号，小号=微信小号
    """
    pm = clean(pay_method)
    if pm in RELATIVE_PAY_KEYS or pm.startswith(RELATIVE_PAY_PREFIX):
        return ACC_RELATIVE
    mapped = BANK_PAY_MAP.get(pm)
    if mapped:
        return mapped
    return ACC_WX_MAIN if nickname_key == "main" else ACC_WX_SUB


def parse_wechat(path: Path, nickname_key: str, W) -> tuple[list[dict], dict]:
    """解析一个微信 xlsx。复用 W.read_wechat_xlsx 与 W.note_text。"""
    header_line, header, rows = W.read_wechat_xlsx(path)
    recs, skipped = [], collections.Counter()

    for row in rows:
        direction = clean(row.get("收/支"))
        status = clean(row.get("当前状态"))
        pay = row.get("支付方式")
        if direction == "支出":
            tx_type = "支出"
        elif direction == "收入":
            tx_type = "收入"
        else:
            skipped[f"不计收支(收/支={direction or '空'})"] += 1
            continue

        cents = money(row.get("金额(元)"))
        if cents is None:
            skipped["金额无法解析"] += 1
            continue
        # 微信账单金额本身已是正数；若出现负数按绝对值处理并记录
        if cents < 0:
            skipped["金额为负(取绝对值)"] += 1
            cents = abs(cents)

        uid = clean(row.get("交易单号")) or uid_hash(
            norm_time(row.get("交易时间")), cents, clean(row.get("交易对方")))
        note = W.note_text(row)          # 与历史账本格式一致
        note = f"{note}；交易单号:{uid}" if note else f"交易单号:{uid}"
        mch = clean(row.get("商户单号"))
        if mch:
            note += f"；商户单号:{mch}"

        rec = make_rec(
            transaction_time=norm_time(row.get("交易时间")),
            type=tx_type,
            category_level1="", category_level2="", category="",
            amount=cents_to_str(cents),
            currency="CNY",
            transaction_object=clean(row.get("交易对方")),
            account=wx_account(pay, nickname_key),
            target_account="",
            participant="自己",
            note=note,
            source_kind="微信支付",
            source_file=path.name,
            uid=uid,
        )
        rec["_cents"] = cents
        rec["_pay"] = clean(pay)
        rec["_status"] = status
        rec["_wx_type"] = clean(row.get("交易类型"))
        recs.append(rec)

    subject = ACC_WX_MAIN if nickname_key == "main" else ACC_WX_SUB
    info = {
        "header_line": header_line,
        "raw_rows": len(rows),
        "skipped": dict(skipped),
        "nickname": subject,
        "subject_account": subject,
        "ident": wechat_identifier(path),
    }
    return recs, info


# ----------------------------------------------------------------------------
# 支付宝 csv —— 优先复用项目既有解析函数
# ----------------------------------------------------------------------------
def _load_alipay_module():
    if str(SKILL_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SKILL_SCRIPTS))
    import import_alipay_bill as A  # noqa
    return A


def ap_account(pay_raw: str, owner_key: str) -> str:
    """
    支付宝账单的 account = 按"收/付款方式"映射。
      - 邮储银行储蓄卡(卡号尾号)[&券] -> 邮储卡     （跨来源重复来源）
      - 招商银行储蓄卡(卡号尾号)[&券] -> 招商银行   （跨来源重复来源）
      - 账户余额 / 余额 / 空 / 钱包   -> 支付宝（BILL_ACC_ALIPAY）
        注意：两个支付宝账号可能绑定同一张邮储卡、资金池相同，
        此时并入同一个账户，不新建第二个支付宝账户。
        owner_key 仅保留用于统计与账号 A↔B 交叉重复检查。
    """
    key = str(pay_raw or "").strip().split("&", 1)[0].strip()
    mapped = BANK_PAY_MAP.get(key)
    if mapped:
        return mapped
    return ACC_ALIPAY


def parse_alipay(path: Path, owner_key: str, A) -> tuple[list[dict], dict]:
    """解析一个支付宝 csv（GBK）。复用 A.decode_alipay_csv。"""
    header_line, rows = A.decode_alipay_csv(path)
    recs, skipped = [], collections.Counter()

    for row in rows:
        row = {k.strip(): (v or "").strip() for k, v in row.items() if k and k.strip()}
        status = clean(row.get("交易状态"))
        direction = clean(row.get("收/支"))

        if status == "交易关闭":
            skipped["交易关闭(钱未动)"] += 1
            continue
        if direction == "支出":
            tx_type = "支出"
        elif direction == "收入":
            tx_type = "收入"
        else:
            skipped[f"不计收支(收/支={direction or '空'})"] += 1
            continue

        cents = money(row.get("金额"))
        if cents is None:
            skipped["金额无法解析"] += 1
            continue
        if cents < 0:
            skipped["金额为负(取绝对值)"] += 1
            cents = abs(cents)

        order = clean(row.get("交易订单号"))
        uid = order or uid_hash(norm_time(row.get("交易时间")), cents,
                               clean(row.get("交易对方")))
        parts = []
        sp = clean(row.get("商品说明"))
        bz = clean(row.get("备注"))
        if sp:
            parts.append(sp)
        if bz and bz != sp:
            parts.append(bz)
        if status:
            parts.append(f"状态:{status}")
        parts.append(f"交易订单号:{uid}")
        mch = clean(row.get("商家订单号"))
        if mch:
            parts.append(f"商家订单号:{mch}")

        rec = make_rec(
            transaction_time=norm_time(row.get("交易时间")),
            type=tx_type,
            category_level1="", category_level2="", category="",
            amount=cents_to_str(cents),
            currency="CNY",
            transaction_object=clean(row.get("交易对方")),
            account=ap_account(row.get("收/付款方式"), owner_key),
            target_account="",
            participant="自己",
            note="；".join(parts),
            source_kind="支付宝",
            source_file=path.name,
            uid=uid,
        )
        rec["_cents"] = cents
        rec["_pay"] = clean(row.get("收/付款方式"))
        rec["_status"] = status
        rec["_owner"] = owner_key          # "A" / "B"，仅用于交叉重复检查
        recs.append(rec)

    info = {"header_line": header_line, "raw_rows": len(rows),
            "skipped": dict(skipped), "owner": owner_key,
            "subject_account": ACC_ALIPAY,
            "ident": alipay_identifier(path)}
    return recs, info


# ----------------------------------------------------------------------------
# PDF 通用：按 y 中心聚类成行，行内按 x0 排序
# ----------------------------------------------------------------------------
def pdf_rows(page, tol: float = 3.5):
    """把一页 PDF 的 words 按 y 中心聚类成行，返回 [(y_center, [word,...]), ...]。"""
    words = page.get_text("words")   # (x0,y0,x1,y1,word,block,line,wordno)
    items = sorted(words, key=lambda w: ((w[1] + w[3]) / 2.0, w[0]))
    rows = []
    for w in items:
        yc = (w[1] + w[3]) / 2.0
        if rows and abs(yc - rows[-1][0]) <= tol:
            ws = rows[-1][1]
            ws.append(w)
            rows[-1][0] += (yc - rows[-1][0]) / len(ws)   # 行中心取均值，抑制漂移
        else:
            rows.append([yc, [w]])
    return [(yc, sorted(ws, key=lambda w: w[0])) for yc, ws in rows]


def assign_by_anchor(cells, anchors: list[tuple[str, float]], tol: float = 15.0):
    """
    按"列左边界锚点"把一行的词归列。
    anchors = [(列名, 该列 x0 锚点), ...]，锚点取自实测数据行的稳定 x0。
    对每个词取 x0 最近的锚点；距离 > tol 记为 _unplaced（诊断用）。
    """
    out = collections.defaultdict(list)
    unplaced = []
    for w in cells:
        x0 = w[0]
        best = min(anchors, key=lambda a: abs(x0 - a[1]))
        if abs(x0 - best[1]) <= tol:
            out[best[0]].append(w)
        else:
            unplaced.append(w)
    for k in out:
        out[k].sort(key=lambda w: w[0])
    return out, unplaced


def join_words(ws) -> str:
    return "".join(w[4] for w in ws).strip()


# ----------------------------------------------------------------------------
# 招商银行 PDF（2 页）
# ----------------------------------------------------------------------------
CMB_ANCHORS = [
    ("date", 36.0), ("currency", 98.7), ("amount", 156.3),
    ("balance", 234.7), ("summary", 307.9), ("counterparty", 417.6),
]
CMB_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_cmb(path: Path) -> tuple[list[dict], dict]:
    """
    招行行格式：记账日期 | 货币 | 交易金额 | 联机余额 | 交易摘要 | 对手信息
    - 表头在第 1 页出现过、第 2 页重复出现 → 靠"日期锚点"识别数据行即可跳过
    - 跳过页脚 (1/2, 2/2)、"合并统计"区、"温馨提示"区
    - 只有记账日期、没有时分秒 → 时间补 00:00:00，并在 note 里标注
    """
    import pymupdf

    doc = pymupdf.open(path)
    recs, diag = [], collections.Counter()
    footer_totals = {}
    unplaced_total = 0
    seq = 0          # 招行流水无单号，用「页-序号」做唯一键，避免同额同对象的真实两笔被误判重复

    for pno in range(doc.page_count):
        page = doc[pno]
        for yc, ws in pdf_rows(page):
            first = ws[0][4].strip() if ws else ""
            line_txt = join_words(ws)

            # 合并统计区：定位"合并收入(+)"表头，随后找币种行取数
            if "合并收入" in line_txt:
                diag["_saw_summary_header"] = 1
                footer_totals["_pending"] = yc
                continue
            if "_pending" in footer_totals and line_txt.startswith("CNY"):
                nums = [w[4] for w in ws if re.match(r"^-?[\d,]+\.\d{2}$", w[4])]
                if len(nums) >= 2:
                    footer_totals["income"] = nums[0]
                    footer_totals["expense"] = nums[1]
                footer_totals.pop("_pending", None)
                continue

            # 数据行：首词是 YYYY-MM-DD
            if not CMB_DATE_RE.match(first):
                if "温馨提示" in line_txt or "页数" in line_txt:
                    diag["跳过页脚/提示"] += 1
                continue

            # 页眉里的「起止日期：2025-11-11 -- 2026-11-11」也是日期打头，
            # 但一行里有 >=2 个日期样式的词 → 不是流水行，跳过
            date_like = [w for w in ws if CMB_DATE_RE.match(w[4].strip())]
            if len(date_like) >= 2:
                diag["跳过页眉起止日期"] += 1
                continue

            cells, unplaced = assign_by_anchor(ws, CMB_ANCHORS, tol=20.0)
            unplaced_total += len(unplaced)
            date = join_words(cells.get("date", []))
            amt_txt = join_words(cells.get("amount", []))
            cents = money(amt_txt)
            if cents is None:
                diag["金额无法解析"] += 1
                continue

            tx_type = "支出" if cents < 0 else "收入"
            summary = join_words(cells.get("summary", []))
            counterparty = join_words(cells.get("counterparty", []))
            seq += 1
            # 注意：不能用内容哈希当 uid ——
            # 招行同一天出现过多笔"同金额+同摘要+同对手"的真实交易
            # （如某日两笔 -0.10 快捷支付 用户，余额 1234.50→1234.40），
            # 用内容哈希会把它们误当重复删掉。这里用页码+行序号保证唯一。
            uid = f"CMB-p{pno + 1}-{seq:03d}"

            note_parts = [f"银行流水｜摘要:{summary}"]
            if counterparty:
                note_parts.append(f"对手信息:{counterparty}")
            note_parts.append("记账日期仅到日,时间补00:00:00")
            note_parts.append(f"内部序号:{uid}")

            rec = make_rec(
                transaction_time=norm_time(date),   # 只有日期 → 00:00:00
                type=tx_type,
                category_level1="", category_level2="", category="",
                amount=cents_to_str(cents),
                currency=join_words(cells.get("currency", [])) or "CNY",
                transaction_object=counterparty,
                account=ACC_CMB,
                target_account="",
                participant="自己",
                note="；".join(note_parts),
                source_kind="招商银行",
                source_file=path.name,
                uid=uid,
            )
            rec["_cents"] = abs(cents)
            rec["_pay"] = ""
            rec["_status"] = ""
            rec["_summary"] = summary
            rec["_balance"] = join_words(cells.get("balance", []))
            rec["_date_only"] = True
            recs.append(rec)

    pages = doc.page_count
    doc.close()

    # 用 PDF 自带的"合并统计"做校验
    parsed_in = sum(r["_cents"] for r in recs if r["type"] == "收入")
    parsed_out = sum(r["_cents"] for r in recs if r["type"] == "支出")
    check = {
        "pages": pages,
        "pdf_income": money(footer_totals.get("income")),
        "pdf_expense": money(footer_totals.get("expense")),
        "parsed_income": parsed_in,
        "parsed_expense": parsed_out,
        "unplaced_words": unplaced_total,
        "diag": dict(diag),
    }
    check["income_match"] = (check["pdf_income"] is not None
                             and check["pdf_income"] == check["parsed_income"])
    check["expense_match"] = (check["pdf_expense"] is not None
                              and abs(check["pdf_expense"]) == check["parsed_expense"])
    check["subject_account"] = ACC_CMB
    check["ident"] = bank_identifier(path, "招商银行")
    return recs, check


# ----------------------------------------------------------------------------
# 邮储银行 PDF（14 页）
# ----------------------------------------------------------------------------
PSBC_ANCHORS = [
    ("time", 38.0), ("sub", 89.0), ("kind", 126.0), ("currency", 170.0),
    ("cash", 220.0), ("amount", 245.0), ("balance", 308.0),
    ("counterparty", 370.0), ("cp_account", 508.0), ("summary", 608.0),
    ("channel", 658.0), ("ext_flow", 739.0),
]
PSBC_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PSBC_HMS_RE = re.compile(r"^\d{2}:\d{2}:\d{2}$")


def parse_psbc(path: Path) -> tuple[list[dict], dict]:
    """
    邮储列：交易时间|子账号|储种|币种|钞汇|交易金额|交易余额|对方户名|对方账号|
            摘要|交易渠道|外部系统流水

    坑：一条记录占两行。
      主行 = 2026-01-01 | 0001 | 结算活期 | ... | -6.50 | 1234.56 | 某商户   | ... | 2026010100000001
      续行 = 17:26:44 | 120567090100000          <- 时分秒 + 外部流水号续行
      或   续行 = 12:39:49 | 商户)                <- 时分秒 + 对方户名续行
    处理：主行开一条记录；续行的时分秒接回日期，其余词按锚点归列并"接续"到对应字段。
    """
    import pymupdf

    doc = pymupdf.open(path)
    recs = []
    diag = collections.Counter()
    unplaced_total = 0
    header_totals = {}
    cur = None          # 当前正在累积的记录
    counts = collections.Counter()
    pend_totals = set()  # 首页合计中被劈行的字段

    def flush():
        nonlocal cur
        if cur is not None:
            recs.append(cur)
            cur = None

    for pno in range(doc.page_count):
        page = doc[pno]
        for yc, ws in pdf_rows(page):
            line_txt = join_words(ws)
            first = ws[0][4].strip() if ws else ""

            # 首页头部：总收入 / 总支出（用于校验）
            # 坑：PDF 把"查询时间内总支出"与数值劈成两行，
            #     上一行结尾是"总支出"，下一行开头是"：5678.90元" → 用 pending 兜住
            if "总收入" in line_txt or "总支出" in line_txt:
                for w in ws:
                    t = w[4]
                    m = re.search(r"([\d,]+\.\d{2})", t)
                    if "总收入" in t:
                        if m:
                            header_totals.setdefault("income", m.group(1))
                        else:
                            pend_totals.add("income")
                    elif "总支出" in t:
                        if m:
                            header_totals.setdefault("expense", m.group(1))
                        else:
                            pend_totals.add("expense")
                continue
            if pend_totals:
                m = re.search(r"([\d,]+\.\d{2})", line_txt)
                if m:
                    for f in ("income", "expense"):
                        if f in pend_totals and f not in header_totals:
                            header_totals[f] = m.group(1)
                            break
                    pend_totals.clear()
                    continue
            # 表头行 / 页脚行
            if "交易时间" in line_txt and "子账号" in line_txt:
                diag["跳过表头"] += 1
                continue
            if re.search(r"第\s*\d+\s*页", line_txt) or "共" in line_txt and "页" in line_txt:
                diag["跳过页脚"] += 1
                continue
            if "中国邮政储蓄银行" in line_txt or "卡号/账号" in line_txt:
                diag["跳过页眉"] += 1
                continue

            # 主行：首词是日期
            if PSBC_DATE_RE.match(first):
                flush()
                cells, unplaced = assign_by_anchor(ws, PSBC_ANCHORS, tol=15.0)
                unplaced_total += len(unplaced)
                date = join_words(cells.get("time", []))
                cents = money(join_words(cells.get("amount", [])))
                cur = {
                    "date": date, "hms": "",
                    "sub": join_words(cells.get("sub", [])),
                    "kind": join_words(cells.get("kind", [])),
                    "currency": join_words(cells.get("currency", [])),
                    "cash": join_words(cells.get("cash", [])),
                    "cents": cents,
                    "balance": join_words(cells.get("balance", [])),
                    "counterparty": join_words(cells.get("counterparty", [])),
                    "cp_account": join_words(cells.get("cp_account", [])),
                    "summary": join_words(cells.get("summary", [])),
                    "channel": join_words(cells.get("channel", [])),
                    "ext_flow": join_words(cells.get("ext_flow", [])),
                }
                continue

            # 续行：首词是时分秒
            if PSBC_HMS_RE.match(first) and cur is not None:
                cells, unplaced = assign_by_anchor(ws, PSBC_ANCHORS, tol=15.0)
                unplaced_total += len(unplaced)
                hms = join_words(cells.get("time", []))
                if hms:
                    cur["hms"] = hms
                for field in ("counterparty", "cp_account", "ext_flow",
                              "summary", "channel", "sub"):
                    piece = join_words(cells.get(field, []))
                    if piece:
                        cur[field] = (cur[field] or "") + piece
                counts["续行"] += 1
                continue

            counts["其它行跳过"] += 1

    flush()
    n_pages = doc.page_count
    doc.close()

    # 组装标准记录
    out = []
    for idx, c in enumerate(recs, 1):
        if c["cents"] is None:
            diag["金额无法解析"] += 1
            continue
        if not c["hms"]:
            diag["缺时分秒"] += 1
        tx_type = "支出" if c["cents"] < 0 else "收入"
        ts = norm_time(f"{c['date']} {c['hms']}") if c["hms"] else norm_time(c["date"])
        # 优先用 PDF 自带的外部系统流水号；个别行（现金开卡/ATM 等）没有流水号，
        # 退回"页内序号"而不是内容哈希 —— 内容哈希会把同额同对象的真实两笔误判重复。
        uid = c["ext_flow"] or f"PSBC-{idx:04d}"
        note_parts = [f"银行流水｜摘要:{c['summary']}"]
        if c["channel"]:
            note_parts.append(f"渠道:{c['channel']}")
        note_parts.append(f"流水号:{c['ext_flow'] or uid}")
        rec = make_rec(
            transaction_time=ts,
            type=tx_type,
            category_level1="", category_level2="", category="",
            amount=cents_to_str(c["cents"]),
            currency="CNY",
            transaction_object=c["counterparty"],
            account=ACC_PSBC,
            target_account="",
            participant="自己",
            note="；".join(note_parts),
            source_kind="邮储银行",
            source_file=path.name,
            uid=uid,
        )
        rec["_cents"] = abs(c["cents"])
        rec["_pay"] = ""
        rec["_status"] = ""
        rec["_summary"] = c["summary"]
        rec["_channel"] = c["channel"]
        rec["_cp_account"] = c["cp_account"]
        rec["_balance"] = c["balance"]
        out.append(rec)

    parsed_in = sum(r["_cents"] for r in out if r["type"] == "收入")
    parsed_out = sum(r["_cents"] for r in out if r["type"] == "支出")
    check = {
        "pages": n_pages,
        "pdf_income": money(header_totals.get("income")),
        "pdf_expense": money(header_totals.get("expense")),
        "parsed_income": parsed_in,
        "parsed_expense": parsed_out,
        "unplaced_words": unplaced_total,
        "diag": dict(diag),
        "found_records": len(recs),
    }
    check["income_match"] = (check["pdf_income"] is not None
                             and check["pdf_income"] == check["parsed_income"])
    check["expense_match"] = (check["pdf_expense"] is not None
                              and abs(check["pdf_expense"]) == check["parsed_expense"])
    check["subject_account"] = ACC_PSBC
    check["ident"] = bank_identifier(path)
    return out, check


# ----------------------------------------------------------------------------
# 去重
# ----------------------------------------------------------------------------
def dedupe_same_source(all_recs: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """
    同来源去重：同 source_kind 下 uid 相同 -> 视为同一笔，保留第一条。
    返回 (保留记录, 被剔除记录, 统计)。
    """
    kept, dropped = [], []
    seen = {}
    stat = collections.Counter()
    for rec in all_recs:
        key = (rec["source_kind"], rec["uid"])
        if key in seen:
            first = seen[key]
            # 只有核心字段一致才算"真重复"（防止不同笔恰好撞单号）
            same = (first["transaction_time"] == rec["transaction_time"]
                    and first["amount"] == rec["amount"]
                    and first["type"] == rec["type"])
            if same:
                rec = dict(rec)
                rec["dup_kind"] = "同源精确重复(同单号同时同时金额)"
                rec["dup_of"] = first["source_file"]
                dropped.append(rec)
                stat[f"同源精确重复·{rec['source_kind']}"] += 1
                continue
            rec = dict(rec)
            rec["dup_kind"] = "同单号但字段不同(保留)"
            stat[f"同单号字段不同·{rec['source_kind']}"] += 1
        seen.setdefault(key, rec)
        kept.append(rec)
    return kept, dropped, dict(stat)


def find_alipay_owner_overlap(ap_recs: list[dict]) -> tuple[list[dict], dict]:
    """
    两个支付宝账号绑定同一张邮政卡、资金池相同时并入同一账户。因此必须检查两个 CSV
    之间有没有**内容完全相同**的条目（同时间 + 同金额 + 同方向 + 同交易对象）——
    如果有，就是同一笔被两个账号各记一次，按重复处理并单列报告。

    返回 (重复的 B 侧记录列表, 统计)。被判定重复的 B 侧记录会在主表剔除。
    """
    rec_a = [r for r in ap_recs if r.get("_owner") == "A"]
    rec_b = [r for r in ap_recs if r.get("_owner") == "B"]

    def key(r):
        return (r["transaction_time"], r["type"], r["_cents"], r["transaction_object"])

    idx = collections.defaultdict(list)
    for r in rec_a:
        idx[key(r)].append(r)

    dup_b, pairs = [], []
    for b in rec_b:
        k = key(b)
        if k in idx:
            a = idx[k][0]
            pairs.append({
                "时间": b["transaction_time"], "方向": b["type"], "金额": b["amount"],
                "对象": b["transaction_object"],
                "账号A订单号": a["uid"], "账号B订单号": b["uid"],
                "账号A付款方式": a.get("_pay", ""), "账号B付款方式": b.get("_pay", ""),
            })
            bb = b                      # 直接改原对象，便于主表按 id 剔除
            bb["dup_kind"] = "支付宝账号间内容相同"
            bb["dup_of"] = a["source_file"]
            dup_b.append(bb)

    info = {
        "账号A笔数": len(rec_a),
        "账号B笔数": len(rec_b),
        "内容相同条目对数": len(pairs),
        "结论": ("两账号之间存在重复交易，已按重复剔除 B 侧" if pairs
                 else "两账号之间无重复交易（仅资金池相同，交易各自独立）"),
    }
    return dup_b, {"info": info, "pairs": pairs}


def find_cross_source(all_recs: list[dict]) -> tuple[list[dict], dict]:
    """
    跨来源疑似重复：同一笔钱在"支付平台"和"银行"各留一条视角。
    只做标注，不删除。

    A 档（高置信）：平台付款方式直接指向某银行账户 + 金额相等 + 方向一致 + 时间差<=180s
    B 档（低置信）：付款方式不指向银行，但金额相等 + 方向一致 + 时间差<=180s
    """
    from datetime import datetime

    def ts(rec):
        try:
            return datetime.strptime(rec["transaction_time"], "%Y-%m-%d %H:%M:%S")
        except Exception:
            return None

    bank = [r for r in all_recs if r["source_kind"] in BANK_SOURCES]
    platform = [r for r in all_recs if r["source_kind"] not in BANK_SOURCES]

    # 银行侧索引：(account, 方向, 金额分) -> [rec]
    bidx = collections.defaultdict(list)
    for r in bank:
        t = ts(r)
        if t is None:
            continue
        bidx[(r["account"], r["type"], r["_cents"])].append((t, r))
    for k in bidx:
        bidx[k].sort(key=lambda x: x[0])

    pairs = []
    used_bank = set()
    for p in sorted(platform, key=lambda r: r["transaction_time"]):
        pt = ts(p)
        if pt is None:
            continue
        # 候选银行账户：付款方式指向的银行；否则所有银行账户
        target_acc = p["account"] if p["account"] in BANK_ACCOUNTS else None
        pay = (p.get("_pay") or "")
        hinted = None
        for key, acc in BANK_PAY_MAP.items():
            if key in pay:
                hinted = acc
                break
        candidates_acc = {hinted} if hinted else ({target_acc} if target_acc else BANK_ACCOUNTS)
        best = None
        for acc in candidates_acc:
            for (bacc, btype, bcents), lst in bidx.items():
                if bacc != acc or btype != p["type"] or bcents != p["_cents"]:
                    continue
                for bt, br in lst:
                    if id(br) in used_bank:
                        continue
                    delta = abs((bt - pt).total_seconds())
                    # 招行只有日期（00:00:00），放宽到"同一天"
                    if getattr(br, "_date_only", False):
                        same_day = bt.date() == pt.date()
                        if not same_day:
                            continue
                        delta = 0 if same_day else delta
                    if delta > CROSS_WINDOW_SEC:
                        continue
                    grade = "A" if hinted else "B"
                    score = (0 if grade == "A" else 1, delta)
                    if best is None or score < best[0]:
                        best = (score, br, grade, acc)
        if best:
            _, br, grade, acc = best
            used_bank.add(id(br))
            pairs.append({
                "grade": grade,
                "platform_time": p["transaction_time"],
                "platform_source": p["source_kind"],
                "platform_account": p["account"],
                "platform_pay": pay,
                "platform_object": p["transaction_object"],
                "bank_time": br["transaction_time"],
                "bank_source": br["source_kind"],
                "bank_account": br["account"],
                "bank_object": br["transaction_object"],
                "type": p["type"],
                "amount": p["amount"],
                "delta_sec": int(abs((ts(br) - pt).total_seconds()))
                if not getattr(br, "_date_only", False) else None,
                "bank_rec": br,
                "platform_rec": p,
            })

    info = {
        "total_pairs": len(pairs),
        "grade_A": sum(1 for x in pairs if x["grade"] == "A"),
        "grade_B": sum(1 for x in pairs if x["grade"] == "B"),
        "amount_sum": cents_to_str(sum(x["platform_rec"]["_cents"] for x in pairs)),
    }
    return pairs, info


def mark_flags(recs: list[dict], pairs: list[dict]):
    """给记录打 flag：跨来源疑似重复 / 疑似内部划转。"""
    pair_tag = {}
    for i, p in enumerate(pairs, 1):
        tag = f"跨来源疑似重复#{i}({p['grade']}档)"
        pair_tag[id(p["platform_rec"])] = tag
        pair_tag[id(p["bank_rec"])] = tag
    for r in recs:
        r["flag"] = pair_tag.get(id(r), "")

    # 疑似内部划转/理财：摘要或交易类型里出现这些词
    INTERNAL_KEYS = ("转入", "转出", "朝朝宝", "零钱提现", "零钱充值", "转账到银行卡",
                     "结息", "利息", "还款", "充值", "提现")
    for r in recs:
        if r["flag"]:
            continue
        blob = f"{r.get('_summary', '')}{r.get('_wx_type', '')}{r['note']}"
        if any(k in blob for k in INTERNAL_KEYS):
            r["flag"] = "疑似内部划转/理财(请人工确认)"


# ----------------------------------------------------------------------------
# 输出
# ----------------------------------------------------------------------------
def write_csv(path: Path, recs: list[dict], fields: list[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(recs)
    return path


def brief(rec: dict) -> str:
    return (f"{rec['transaction_time']} {rec['type']:<2} {rec['amount']:>9} "
            f"{rec['account']:<14} {rec['transaction_object'][:20]:<22} "
            f"{(rec.get('note') or '')[:44]}")


def print_sample(title: str, recs: list[dict]):
    print(f"\n  ── {title}：首尾各 2 条（按时间正序）──")
    srt = sorted(recs, key=lambda r: r["transaction_time"])
    for r in srt[:2]:
        print("     [首] " + brief(r))
    if len(srt) > 4:
        print(f"          ... 共 {len(srt)} 条 ...")
    for r in srt[-2:]:
        print("     [尾] " + brief(r))
    if not srt:
        print("     （无记录）")


def time_range(recs: list[dict]) -> tuple[str, str]:
    if not recs:
        return "", ""
    ts = [r["transaction_time"] for r in recs if r["transaction_time"]]
    return (min(ts), max(ts)) if ts else ("", "")


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

# ============================================================================
# 项目接入层（本段为 My Economic 看板调用而写，不是从外部项目搬来的）
#   目录扫描 → 解析 → 去重 → 与账本判重 → 预览 / 执行
#   设计口径：
#     · 预览只读，绝不写库、绝不在正式目录落文件
#     · 执行前一定先物理备份数据库
#     · 新条目 status='pending'、category 为空
#     · 绝不删除、绝不覆盖任何已有账目
# ============================================================================
import shutil
import sqlite3
import time as _time

PROJECT_SCRIPTS = Path(__file__).resolve().parent
CROSS_FLAG = "跨来源疑似重复"
DEFAULT_NEAR_SEC = 300
# 支付平台来源（银行流水之外的一侧）与亲属卡映射口径
PLATFORM_SOURCES = {"微信支付", "支付宝"}
QIN_ACCOUNT = "亲属卡"
QIN_TARGET_ACCOUNT = ACC_WX_MAIN
QIN_TAG = os.environ.get("BILL_QIN_TAG") or "亲属卡"
_SUPPORTED = {
    ".xlsx": "微信支付",
    ".csv": "支付宝",
    ".pdf": "银行PDF",
}


# ---------------------------------------------------------------- 模块加载
def _load_bookkeeping(db_path=None):
    """拿到 bookkeeping 模块，并校验 DB_PATH 与期望一致（防写错库）。"""
    want = Path(db_path or DB_PATH_DEFAULT).resolve()
    os.environ.setdefault("BOOKKEEPING_DB_PATH", str(want))
    if str(PROJECT_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(PROJECT_SCRIPTS))
    import bookkeeping as K
    got = Path(K.DB_PATH).resolve()
    if got != want:
        raise RuntimeError(
            "数据库路径校验失败，已中止：bookkeeping.DB_PATH=%s 期望=%s" % (got, want))
    return K


def _db_file(db_path=None):
    p = Path(db_path or os.environ.get("BOOKKEEPING_DB_PATH")
             or (Path.home() / ".local/share/bookkeeping/bookkeeping.db"))
    return p


DB_PATH_DEFAULT = os.environ.get("BOOKKEEPING_DB_PATH") or str(
    Path.home() / ".local/share/bookkeeping/bookkeeping.db")


# ---------------------------------------------------------------- 目录扫描
def collect_bill_files(src_root):
    """扫描账单目录。优先按 微信/支付宝/招商银行/邮政银行 子目录识别，根目录文件兜底。"""
    root = Path(src_root)
    if not root.exists():
        raise RuntimeError("账单目录不存在：%s" % root)
    if not root.is_dir():
        raise RuntimeError("不是文件夹：%s" % root)

    def _pick(p, ext):
        s = str(p)
        low = s.lower()
        name = p.name
        if ext == ".xlsx":
            return "微信支付", ("main" if "大号" in s else "sub")
        if ext == ".csv":
            return "支付宝", alipay_owner_key(name)
        if ext == ".pdf":
            if "招商" in s or "cmb" in low:
                return "招商银行", None
            if "邮储" in s or "邮政" in s or "psbc" in low:
                return "邮储银行", None
            return "未知PDF", None
        return None, None

    found = []
    used = set()
    # 1) 标准四子目录
    dir_map = [("微信", ".xlsx"), ("支付宝", ".csv"), ("招商银行", ".pdf"), ("邮政银行", ".pdf")]
    for sub, ext in dir_map:
        d = root / sub
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*" + ext)):
            if not p.is_file():
                continue
            src, key = _pick(p, ext)
            if ext == ".xlsx" and "大号" not in str(p) and sub == "微信":
                key = "sub"
            found.append({"path": p, "source": src, "key": key, "ext": ext})
            used.add(p.resolve())
    # 2) 根目录兜底（不重复收子目录里已收的）
    for ext in (".xlsx", ".csv", ".pdf"):
        for p in sorted(root.rglob("*" + ext)):
            if not p.is_file() or p.resolve() in used:
                continue
            src, key = _pick(p, ext)
            if src in ("未知PDF", None):
                continue
            found.append({"path": p, "source": src, "key": key, "ext": ext})
            used.add(p.resolve())
    for item in found:
        if item["ext"] == ".xlsx" and item["key"] is None:
            item["key"] = "main" if "大号" in str(item["path"]) else "sub"
        if item["ext"] == ".csv" and item["key"] is None:
            item["key"] = alipay_owner_key(item["path"].name)
    return found


# ---------------------------------------------------------------- 解析全部
def parse_all(src_root, want_files=True):
    """解析目录下全部账单，返回到「跨来源配对标注完成」的合并总表（未与账本判重）。"""
    files = collect_bill_files(src_root)
    if not files:
        raise RuntimeError(
            "目录里没找到可识别的账单文件：%s\n"
            "支持 微信 .xlsx / 支付宝 .csv / 招商银行 .pdf / 邮政银行 .pdf" % src_root)

    W = _load_wechat_module() if any(f["ext"] == ".xlsx" for f in files) else None
    A = _load_alipay_module() if any(f["ext"] == ".csv" for f in files) else None

    raw_all, file_rows, errors, identifier_files = [], [], [], []
    for f in files:
        p, src, key = f["path"], f["source"], f["key"]
        try:
            if src == "微信支付":
                recs, info = parse_wechat(p, key, W)
            elif src == "支付宝":
                recs, info = parse_alipay(p, key, A)
            elif src == "招商银行":
                recs, info = parse_cmb(p)
            elif src == "邮储银行":
                recs, info = parse_psbc(p)
            else:
                continue
            t0, t1 = time_range(recs)
            file_rows.append({
                "name": p.name, "source": src, "rows": len(recs),
                "start": t0, "end": t1,
                "raw_rows": info.get("raw_rows") if isinstance(info, dict) else None,
            })
            # --- 账户标识：文件级提取，并给该文件的每条记录打上「所属标识 + 主体账户」---
            ident = (info.get("ident") or {}) if isinstance(info, dict) else {}
            subject = (info.get("subject_account") or "") if isinstance(info, dict) else ""
            identifier = str(ident.get("identifier") or "").strip()
            subject_rows = sum(1 for r in recs
                               if (r.get("account") or "") == subject) if subject else 0
            for r in recs:
                r["_ident"] = identifier
                r["_subject_account"] = subject
            if identifier:
                identifier_files.append({
                    "file": p.name,
                    "path": str(p),
                    "source": src,
                    "source_kind": SOURCE_GROUP.get(src, ""),
                    "identifier": identifier,
                    "hint": ident.get("hint") or "",
                    "bank_name": ident.get("bank_name") or "",
                    "owner_name": ident.get("owner_name") or "",
                    "card_tail": ident.get("card_tail") or "",
                    "subject_account": subject,
                    "entry_count": subject_rows,
                })
            raw_all.extend(recs)
        except Exception as exc:      # 单个坏文件不拖垮整批
            errors.append({"name": p.name, "error": "%s: %s" % (type(exc).__name__, exc)})

    if not raw_all:
        raise RuntimeError("所有文件都没解析出记录。明细：" +
                           "; ".join("%s → %s" % (e["name"], e["error"]) for e in errors[:5]))

    raw_total = len(raw_all)
    kept, dropped, dup_stat = dedupe_same_source(raw_all)

    # 支付宝 账号 A ↔ B 交叉重复
    ap_kept = [r for r in kept if r.get("source_kind") == "支付宝"]
    ai = {}
    if ap_kept:
        ap_dup, ap_chk = find_alipay_owner_overlap(ap_kept)
        ai = ap_chk.get("info") or {}
        if ap_chk.get("pairs"):
            drop_ids = {id(r) for r in ap_dup}
            kept = [r for r in kept if id(r) not in drop_ids]
            dropped.extend(ap_dup)
            dup_stat["支付宝账号间内容相同"] = len(ap_dup)

    pairs, pinfo = find_cross_source(kept)
    mark_flags(kept, pairs)
    kept.sort(key=lambda r: (r.get("transaction_time") or "", r.get("source_kind") or ""))

    by_source = collections.Counter(r.get("source_kind") for r in kept)
    by_account = collections.Counter(r.get("account") for r in kept)
    by_type = collections.Counter(r.get("type") for r in kept)

    # 账户标识的条数改用「去重后、且仍落在该来源主体账户上」的记录数，
    # 这样「账户对应」里显示的数字和 by_account 口径一致，不会让人以为丢数了。
    id_count = collections.Counter()
    for r in kept:
        ident = str(r.get("_ident") or "")
        if ident and (r.get("account") or "") == (r.get("_subject_account") or ""):
            id_count[(str(r.get("source_file") or ""), ident)] += 1
    for item in identifier_files:
        item["entry_count"] = id_count.get((item["file"], item["identifier"]), 0)

    return {
        "src_root": str(src_root),
        "files": file_rows,
        "errors": errors,
        "file_count": len(files),
        "raw_total": raw_total,
        "same_source_dropped": len(dropped),
        "dedup_total": len(kept),
        "dedup_detail": dict(dup_stat),
        "alipay_overlap": ai,
        "cross_pairs": pinfo.get("total_pairs", 0),
        "by_source": dict(by_source),
        "by_account": dict(by_account),
        "by_type": dict(by_type),
        "identifier_files": identifier_files,
        "records": kept,
    }


# ---------------------------------------------------------------- 与账本判重
def _db_snapshot(conn):
    n = conn.execute("select count(*) from entries").fetchone()[0]
    accounts = {r[0]: r[1] for r in conn.execute(
        "select name, current_balance_cents from accounts")}
    rows = [dict(r) for r in conn.execute(
        "select id, transaction_time, type, amount_cents, account, "
        "transaction_object, status, category from entries")]
    return {"count": n, "accounts": accounts, "rows": rows}


def _parse_ts(text):
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return __import__("datetime").datetime.strptime(str(text).strip(), fmt)
        except Exception:
            continue
    return None


def plan_import(parsed, db_path=None, near=DEFAULT_NEAR_SEC, cross_source="both",
                account_mapping=None):
    """把解析结果折算成「将要插入什么」，全程只读。

    account_mapping：{"账单里的账户标识": "本地账户名"}，由前端「账户对应」下拉
    或 /api/import-execute 的 payload 传入。用户改过的映射优先；没传的标识走
    自动推导；自动推导也没有的，仍回退到 BILL_ACC_* 环境变量常量（解析阶段就已
    按常量落好 account，所以这里不传 = 维持旧行为）。
    """
    db_path = _db_file(db_path)
    mapping = normalize_account_mapping(account_mapping)
    records = list(parsed["records"])

    # --- 基础过滤 ---
    drops = collections.Counter()
    keep = []
    for r in records:
        if _cents(r.get("amount")) is None:
            drops["金额无法解析"] += 1
            continue
        if _cents(r.get("amount")) == 0:
            drops["0 元记录"] += 1
            continue
        if not str(r.get("account") or "").strip():
            drops["账户为空"] += 1
            continue
        if not str(r.get("transaction_time") or "").strip():
            drops["时间为空"] += 1
            continue
        keep.append(r)

    # --- 亲属卡映射（必须在判重之前）---
    qin_rows = [r for r in keep if str(r.get("account") or "").strip() == QIN_ACCOUNT]
    for r in qin_rows:
        r["account"] = QIN_TARGET_ACCOUNT
        r["target_account"] = ""
        r["_qin"] = 1                 # 标记：亲属卡记录不参与文件级账户映射
        note = str(r.get("note") or "")
        if QIN_TAG not in note:
            r["note"] = (note + "；" + QIN_TAG) if note.strip() else QIN_TAG

    # --- 跨来源取舍 ---
    cross = [r for r in keep if CROSS_FLAG in str(r.get("flag") or "")]
    if cross_source in ("platform", "bank") and cross:
        if cross_source == "platform":
            drop_side = lambda r: r.get("source_kind") in BANK_SOURCES
        else:
            drop_side = lambda r: r.get("source_kind") not in BANK_SOURCES
        keep = [r for r in keep if not (CROSS_FLAG in str(r.get("flag") or "") and drop_side(r))]

    # --- 按支付方式判定归属：同一笔钱只生成一次 ---
    merged_plat = []
    _grp = collections.defaultdict(list)
    for r in keep:
        m = re.search(r"跨来源疑似重复#(\d+)", str(r.get("flag") or ""))
        if m:
            _grp[m.group(1)].append(r)
    for gid in sorted(_grp, key=lambda x: int(x)):
        v = _grp[gid]
        plat = [r for r in v if r.get("source_kind") in PLATFORM_SOURCES]
        bank = [r for r in v if r.get("source_kind") not in PLATFORM_SOURCES]
        if not plat or not bank:
            continue
        p, b = plat[0], bank[0]
        acc = str(p.get("account") or "").strip()
        if acc in BANK_ACCOUNTS:
            b["transaction_object"] = p.get("transaction_object") or b.get("transaction_object")
            b["note"] = p.get("note") or b.get("note")
            b["_overlap_forced"] = 1
            b["_merged_from"] = p.get("source_uid")
            p["_merge_into"] = b.get("source_uid")
            merged_plat.append(p)
    if merged_plat:
        keep = [r for r in keep if not r.get("_merge_into")]

    # --- 与已有账本判重（同类型 + 同金额 + 时间 ±near 秒）---
    conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        before = _db_snapshot(conn)
    finally:
        conn.close()

    lidx = collections.defaultdict(list)
    for row in before["rows"]:
        kts = ["转账", "支出", "收入"] if row["type"] == "转账" else [row["type"]]
        t = _parse_ts(row["transaction_time"])
        for kt in kts:
            lidx[(kt, row["amount_cents"])].append((t, row))
    for k in lidx:
        lidx[k].sort(key=lambda x: x[0] if x[0] else 0)

    already, to_insert = [], []
    for r in keep:
        c = _cents(r.get("amount"))
        t = _parse_ts(r.get("transaction_time"))
        hit = None
        pool = list(lidx.get((r.get("type"), c), []))
        if r.get("type") == "转账":
            pool += lidx.get(("支出", c), []) + lidx.get(("收入", c), [])
        for lt, lr in pool:
            if lt is None or t is None:
                continue
            if abs((lt - t).total_seconds()) <= near:
                hit = lr
                break
        (already if hit else to_insert).append(r)

    # --- 账户映射：从账单标识推导 / 用户确认后重写 account ---
    # 重写范围（其余一律不动，保证既有账户归属口径不变）：
    #   1) 原本落在「来源主体账户」上的记录：微信零钱类 / 支付宝余额 / 银行流水本体；
    #   2) 平台账单里「用银行卡支付」的记录（支付方式 = 邮储/招行卡）——
    #      它和该银行的 PDF 流水是同一张卡，必须跟着同一条映射走，
    #      否则用户在「账户对应」里给这张卡改了名，会分裂成两个账户。
    # 亲属卡、跨来源合并后的银行侧记录都不参与。判重已经做完，
    # 所以重复导入仍然是「将新增 0」。
    bank_ident_by_account = {}
    for item in parsed.get("identifier_files") or []:
        if item.get("source_kind") == "bank" and item.get("subject_account"):
            bank_ident_by_account.setdefault(item["subject_account"], item["identifier"])
    mapping_applied = collections.Counter()
    if mapping:
        for r in to_insert:
            if r.get("_qin"):
                continue
            acc = str(r.get("account") or "").strip()
            subject = str(r.get("_subject_account") or "").strip()
            ident = str(r.get("_ident") or "").strip()
            if acc in BANK_ACCOUNTS and acc in bank_ident_by_account:
                subject = acc
                ident = bank_ident_by_account[acc]
            if not ident or not subject or acc != subject:
                continue
            target = mapping.get(ident)
            if target and target != acc:
                r["account"] = target
                mapping_applied[ident] += 1

    # --- 账户归属 ---
    need = collections.Counter()
    need_amount = collections.Counter()
    for r in to_insert:
        need[r["account"]] += 1
        need_amount[r["account"]] += _cents(r.get("amount")) or 0
    new_accounts, existing_accounts = [], []
    for acc in sorted(need, key=lambda a: -need[a]):
        row = {"name": acc, "count": need[acc],
               "amount": cents_to_str(need_amount[acc])}
        (existing_accounts if acc in before["accounts"] else new_accounts).append(row)

    ins_type = collections.Counter(r.get("type") for r in to_insert)
    ins_src = collections.Counter(r.get("source_kind") or "未知" for r in to_insert)
    total_in = sum(_cents(r.get("amount")) or 0 for r in to_insert if r.get("type") == "收入")
    total_out = sum(_cents(r.get("amount")) or 0 for r in to_insert if r.get("type") == "支出")
    spans = [str(r.get("transaction_time") or "")[:10] for r in to_insert if r.get("transaction_time")]
    overlap_n = sum(1 for r in to_insert
                    if CROSS_FLAG in str(r.get("flag") or "") or r.get("_overlap_forced"))

    return {
        "filters": dict(drops),
        "qin_mapped": len(qin_rows),
        "merged_platform": len(merged_plat),
        "already": len(already),
        "to_insert": len(to_insert),
        "insert_records": to_insert,
        "new_accounts": new_accounts,
        "existing_accounts": existing_accounts,
        "mapping_applied": dict(mapping_applied),
        "by_type": dict(ins_type),
        "by_source": dict(ins_src),
        "income_total": cents_to_str(total_in),
        "expense_total": cents_to_str(total_out),
        "overlap_marked": overlap_n,
        "time_start": min(spans) if spans else "",
        "time_end": max(spans) if spans else "",
        "db_before": {"count": before["count"],
                      "accounts": {k: cents_to_str(v) for k, v in before["accounts"].items()}},
    }


def _cents(text):
    return money(text)


# ---------------------------------------------------------------- 预览
def preview_import(src_dir, db_path=None, near=DEFAULT_NEAR_SEC, cross_source="both",
                   account_mapping=None):
    t0 = _time.time()
    parsed = parse_all(src_dir)
    plan = plan_import(parsed, db_path=db_path, near=near, cross_source=cross_source,
                       account_mapping=account_mapping)
    # 本地账户候选 = 数据库里实际存在的账户（有余额的那些），用于「账户对应」下拉
    local_accounts = sorted((plan.get("db_before") or {}).get("accounts", {}).keys())
    suggestions = build_account_suggestions(parsed.get("identifier_files"), local_accounts)
    warnings = []
    if parsed["file_count"] != 11:
        warnings.append("本次识别到 %d 个文件（上次完整导入是 11 个），请确认是否只放了一部分账单。"
                        % parsed["file_count"])
    for e in parsed["errors"]:
        warnings.append("解析失败：%s → %s" % (e["name"], e["error"]))
    if plan["new_accounts"]:
        warnings.append("有 %d 个账户在账本里还不存在，导入时会自动新建（期初 0）。"
                        % len(plan["new_accounts"]))
    if suggestions:
        matched = sum(1 for s in suggestions if s.get("suggested_local"))
        warnings.append("识别到 %d 个账户标识，其中 %d 个匹配到现有账户，%d 个需要新建；"
                        "可在下方「账户对应」里改。"
                        % (len(suggestions), matched, len(suggestions) - matched))
    return {
        "ok": True,
        "preview_only": True,
        "source_dir": str(src_dir),
        "files": parsed["files"],
        "file_count": parsed["file_count"],
        "raw_total": parsed["raw_total"],
        "same_source_dropped": parsed["same_source_dropped"],
        "dedup_total": parsed["dedup_total"],
        "dedup_detail": parsed["dedup_detail"],
        "cross_pairs": parsed["cross_pairs"],
        "by_source": parsed["by_source"],
        "by_account": parsed["by_account"],
        "by_type": parsed["by_type"],
        "already_in_db": plan["already"],
        "to_insert": plan["to_insert"],
        "new_accounts": plan["new_accounts"],
        "existing_accounts": plan["existing_accounts"],
        "account_suggestions": suggestions,
        "account_mapping_applied": plan["mapping_applied"],
        "insert_by_type": plan["by_type"],
        "insert_by_source": plan["by_source"],
        "insert_income": plan["income_total"],
        "insert_expense": plan["expense_total"],
        "insert_time_start": plan["time_start"],
        "insert_time_end": plan["time_end"],
        "qin_mapped": plan["qin_mapped"],
        "merged_platform": plan["merged_platform"],
        "overlap_marked": plan["overlap_marked"],
        "db_count_before": plan["db_before"]["count"],
        "db_count_after": plan["db_before"]["count"] + plan["to_insert"],
        "warnings": warnings,
        "elapsed_ms": int((_time.time() - t0) * 1000),
    }


# ---------------------------------------------------------------- 执行
def execute_import(src_dir, db_path=None, near=DEFAULT_NEAR_SEC, cross_source="both",
                   preview_only=True, backup_dir=None, out_dir=None, account_mapping=None):
    """preview_only=True 时只走预览（默认）。要真写库必须显式传 preview_only=False。"""
    db_path = _db_file(db_path)
    if preview_only:
        res = preview_import(src_dir, db_path=db_path, near=near, cross_source=cross_source,
                             account_mapping=account_mapping)
        res["executed"] = False
        return res

    t0 = _time.time()
    parsed = parse_all(src_dir)
    plan = plan_import(parsed, db_path=db_path, near=near, cross_source=cross_source,
                       account_mapping=account_mapping)
    to_insert = plan["insert_records"]
    before = plan["db_before"]

    if not to_insert:
        return {"ok": True, "executed": True, "inserted": 0, "failed": 0,
                "already_in_db": plan["already"], "to_insert": 0,
                "message": "没有需要插入的新记录（账本里都已存在）。",
                "db_count_before": before["count"], "db_count_after": before["count"],
                "elapsed_ms": int((_time.time() - t0) * 1000)}

    # --- 先备份数据库 ---
    bdir = Path(backup_dir) if backup_dir else (db_path.parent.parent / "_备份")
    stamp = __import__("datetime").datetime.now().strftime("%Y%m%d_%H%M%S")
    bdir = bdir / ("%s_账单导入" % stamp)
    bdir.mkdir(parents=True, exist_ok=True)
    backup = bdir / ("bookkeeping_%s_before_import.db" % stamp)
    src_conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        src_conn.execute("VACUUM INTO ?", (str(backup),))
    finally:
        src_conn.close()

    K = _load_bookkeeping(db_path)
    ok = fail = uid_written = overlap_marked = 0
    failures = []
    conn = K.connect()
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(entries)")}
        if "source_uid" not in cols:
            conn.execute("ALTER TABLE entries ADD COLUMN source_uid TEXT")
        if "overlap_flag" not in cols:
            conn.execute("ALTER TABLE entries ADD COLUMN overlap_flag INTEGER DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_source_uid ON entries(source_uid)")
        for r in to_insert:
            rec = {
                "transaction_time": r.get("transaction_time"),
                "type": r.get("type"),
                "category": "",
                "amount": r.get("amount"),
                "currency": r.get("currency") or "CNY",
                "transaction_object": r.get("transaction_object") or "",
                "account": r.get("account"),
                "target_account": r.get("target_account") or None,
                "participant": r.get("participant") or "自己",
                "note": r.get("note") or "",
            }
            try:
                res = K.insert_entry_with_conn(conn, rec, auto_learn=False)
                su = str(r.get("source_uid") or "").strip()
                if su and res.get("status") != "unconfirmed":
                    conn.execute("update entries set source_uid = ? where id = ?", (su, res["id"]))
                    uid_written += 1
                if (res.get("status") != "unconfirmed"
                        and (CROSS_FLAG in str(r.get("flag") or "") or r.get("_overlap_forced"))):
                    conn.execute("update entries set overlap_flag = 1 where id = ?", (res["id"],))
                    overlap_marked += 1
                ok += 1
            except Exception as exc:
                fail += 1
                failures.append("%s %s %s → %s: %s" % (
                    r.get("transaction_time"), r.get("account"), r.get("amount"),
                    type(exc).__name__, exc))
        try:
            K.sync_account_debts_from_entries(conn)
        except Exception:
            pass
        try:
            K.sync_current_balances_from_entries(conn)
        except Exception:
            pass
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    # --- 落导入台账 ---
    ledger = None
    try:
        odir = Path(out_dir) if out_dir else bdir
        odir.mkdir(parents=True, exist_ok=True)
        ledger = odir / ("导入台账_%s.csv" % stamp)
        with ledger.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["transaction_time", "type", "amount", "account",
                        "transaction_object", "note", "source_kind", "flag",
                        "source_uid", "merged_from"])
            for r in to_insert:
                w.writerow([r.get("transaction_time"), r.get("type"), r.get("amount"),
                            r.get("account"), r.get("transaction_object"), r.get("note"),
                            r.get("source_kind"), r.get("flag"), r.get("source_uid"),
                            r.get("_merged_from") or ""])
    except Exception:
        ledger = None

    conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        after = _db_snapshot(conn)
    finally:
        conn.close()
    ins_type = collections.Counter(r.get("type") for r in to_insert)
    ins_acct = collections.Counter(r.get("account") for r in to_insert)
    acct_delta = []
    for name in sorted(set(before["accounts"]) | set(after["accounts"])):
        b = before["accounts"].get(name, 0)
        a = after["accounts"].get(name, 0)
        if str(b) != str(a):
            acct_delta.append({"name": name, "before": str(b), "after": str(a)})
    return {
        "ok": not fail,
        "executed": True,
        "inserted": ok,
        "failed": fail,
        "failures": failures[:10],
        "already_in_db": plan["already"],
        "to_insert": plan["to_insert"],
        "new_accounts": plan["new_accounts"],
        "account_mapping_applied": plan["mapping_applied"],
        "insert_by_type": dict(ins_type),
        "insert_by_account": dict(ins_acct),
        "overlap_marked": overlap_marked,
        "source_uid_written": uid_written,
        "db_count_before": before["count"],
        "db_count_after": after["count"],
        "accounts_before": before["accounts"],
        "accounts_after": {k: cents_to_str(v) for k, v in after["accounts"].items()},
        "account_delta": acct_delta,
        "backup": str(backup),
        "ledger": str(ledger) if ledger else "",
        "files": parsed["files"],
        "dedup_total": parsed["dedup_total"],
        "elapsed_ms": int((_time.time() - t0) * 1000),
    }
