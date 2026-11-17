#!/usr/bin/env python3
import argparse
import collections
import csv
import datetime as dt
import io
import json
import math
import mimetypes
import os
import re
import sqlite3
import sys
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "scripts" / "bookkeeping_app"
DEFAULT_DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "bookkeeping"
DB_PATH = Path(os.environ.get("BOOKKEEPING_DB_PATH", DEFAULT_DATA_DIR / "bookkeeping.db")).expanduser()
CONFIG_PATH = Path(os.environ.get("BOOKKEEPING_CONFIG_PATH", ROOT / "scripts" / "config.yaml")).expanduser()
STATIC_PATH = APP_PATH / "static"
INDEX_PATH = STATIC_PATH / "index.html"
SCRIPTS_PATH = APP_PATH.parent
# 账单导入默认目录（可用 BILL_IMPORT_DIR 环境变量或接口参数覆盖）
DEFAULT_IMPORT_DIR = str(Path(os.environ.get("BILL_IMPORT_DIR") or (ROOT / "账单导入")))

ENTRY_TYPES = {"支出", "收入", "转账", "借入", "借出", "还款", "收款", "余额修正", "期初资金"}
BALANCE_SIGNS = {
    "支出": -1,
    "收入": 1,
    "借入": 1,
    "借出": -1,
    "还款": -1,
    "收款": 1,
    "余额修正": 1,
    # 期初资金 = 本金注入（开卡后存钱 / 别人汇入）。它让账户余额增加（与收入同向），
    # 但**不是劳动收入**，所以不进任何收支统计、也不需要分类。
    "期初资金": 1,
}
# 计入账户余额、但**不计入收支统计**、也**不需要分类**的类型。
# 收支统计全部是「type in ('收入','收款','借入')」这类白名单写法，所以新类型天然被排除；
# 这个集合只用于「哪些类型可以没有分类」的判定（needs_category）与数据质检的排除。
NON_REPORTING_TYPES = {"转账", "余额修正", "期初资金"}
IMPORT_FIELD_ALIASES = {
    "transaction_time": {
        "transaction_time",
        "time",
        "date",
        "datetime",
        "交易时间",
        "交易日期",
        "记账时间",
        "记账日期",
        "账单时间",
        "发生时间",
        "发生日期",
        "入账时间",
        "入账日期",
        "创建时间",
        "支付时间",
        "付款时间",
        "收款时间",
    },
    "target_account": {
        "target_account",
        "to_account",
        "transfer_account",
        "target",
        "转入账户",
        "收款账户",
        "对方账户",
        "目标账户",
    },
    "transaction_object": {
        "transaction_object",
        "交易对象",
        "交易对方",
        "counterparty",
        "merchant",
        "商家",
        "商户",
        "收付款人",
        "交易方",
        "对方",
    },
}


def now_iso():
    return dt.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def cents(value):
    if value is None or str(value).strip() == "":
        raise ValueError("amount is required")
    text = str(value).strip().replace(",", "").replace("￥", "").replace("¥", "")
    return int(round(float(text) * 100))


def money(cents_value):
    return f"{(cents_value or 0) / 100:.2f}"


def parse_attributes(value):
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def account_balance_delta(tx_type, amount_cents, balance_delta_cents=None):
    if tx_type == "转账":
        return -amount_cents
    direction = -1 if amount_cents < 0 else 1
    amount_cents = abs(amount_cents)
    if tx_type == "余额修正":
        if balance_delta_cents is not None:
            return int(balance_delta_cents) if direction > 0 else -int(balance_delta_cents)
    sign = BALANCE_SIGNS.get(tx_type)
    if sign is None:
        return None
    return direction * sign * amount_cents


ENTRY_COLUMNS = [
    "id",
    "transaction_time",
    "type",
    "category",
    "status",
    "amount_cents",
    "currency",
    "transaction_object",
    "account",
    "target_account",
    "participant",
    "balance_delta_cents",
    "actual_balance_cents",
    "note",
    # 跨来源重复属性：1 = 该条目在另一个来源（银行流水 / 平台账单）里存在疑似同一笔的流水。
    # 只作为结构化属性保存，不写进 note、不影响筛选与统计。
    "overlap_flag",
    # 稳定业务键（重导 / 回放 / 跨来源去重都靠它）。规则：
    #   WX-<微信交易单号> / AL-<支付宝交易订单号> / H-<序号>（招商）/ P-<序号>（邮储）
    # 老库与手工记账条目允许为空。
    "source_uid",
]

UNCONFIRMED_COLUMNS = ENTRY_COLUMNS + ["raw_payload"]


def set_database_path(value):
    global DB_PATH
    if value:
        DB_PATH = Path(value).expanduser()


def migrate_table(conn, table, columns):
    existing = conn.execute(f"pragma table_info({table})").fetchall()
    existing_names = [row["name"] for row in existing]
    if not existing_names or existing_names == columns:
        return
    stale_table = f"{table}_old"
    stale_exists = conn.execute(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        (stale_table,),
    ).fetchone()
    if stale_exists:
        current_count = conn.execute(f"select count(*) from {table}").fetchone()[0]
        stale_columns = [row["name"] for row in conn.execute(f"pragma table_info({stale_table})").fetchall()]
        stale_count = conn.execute(f"select count(*) from {stale_table}").fetchone()[0]
        if current_count == 0 and stale_count > 0 and stale_columns == columns:
            conn.execute(f"drop table {table}")
            conn.execute(f"alter table {stale_table} rename to {table}")
            return
    rows = conn.execute(f"select * from {table}").fetchall()
    temp_table = stale_table
    suffix = 1
    while conn.execute("select 1 from sqlite_master where type = 'table' and name = ?", (temp_table,)).fetchone():
        temp_table = f"{table}_old_{suffix}"
        suffix += 1
    conn.execute(f"alter table {table} rename to {temp_table}")
    create_entries_table(conn, table)
    placeholders = ", ".join("?" for _ in columns)
    insert_sql = f"insert into {table}({', '.join(columns)}) values ({placeholders})"
    for row in rows:
        old = dict(row)
        attrs = parse_attributes(old.get("attributes"))
        values = []
        for column in columns:
            if column == "target_account":
                values.append(old.get("target_account") or old.get("to_account"))
            elif column == "transaction_object":
                values.append(old.get("transaction_object") or old.get("merchant") or old.get("counterparty"))
            elif column == "balance_delta_cents":
                values.append(old.get("balance_delta_cents") if "balance_delta_cents" in old else attrs.get("delta_cents"))
            elif column == "actual_balance_cents":
                values.append(old.get("actual_balance_cents") if "actual_balance_cents" in old else attrs.get("actual_balance_cents"))
            elif column == "status":
                values.append(old.get("status") if "status" in old else ("pending" if table == "unconfirmed_entries" else "confirmed"))
            elif column == "overlap_flag":
                # 老库没有这一列：迁移时统一填 0（不是 None，否则违反 not null）
                values.append(old.get("overlap_flag") if "overlap_flag" in old else 0)
            elif column in old:
                values.append(old.get(column))
            elif column == "currency":
                values.append("CNY")
            elif column == "participant":
                values.append("自己")
            else:
                values.append(None)
        conn.execute(insert_sql, values)
    conn.execute(f"drop table {temp_table}")


def create_entries_table(conn, table):
    raw_payload = ", raw_payload text" if table == "unconfirmed_entries" else ""
    status_default = "pending" if table == "unconfirmed_entries" else "confirmed"
    conn.execute(
        f"""
        create table if not exists {table} (
            id integer primary key autoincrement,
            transaction_time text not null,
            type text,
            category text,
            status text not null default '{status_default}',
            amount_cents integer not null,
            currency text not null default 'CNY',
            transaction_object text,
            account text not null default '',
            target_account text,
            participant text not null default '自己',
            balance_delta_cents integer,
            actual_balance_cents integer,
            note text,
            overlap_flag integer not null default 0,
            source_uid text{raw_payload}
        )
        """
    )


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma foreign_keys = on")
    return conn


def migrate_category_only_unconfirmed(conn):
    rows = conn.execute(
        """
        select *
        from unconfirmed_entries
        where coalesce(account, '') != ''
            and coalesce(type, '') != ''
            and amount_cents != 0
            and type not in ('转账', '余额修正', '期初资金')
            and coalesce(category, '') = ''
        order by transaction_time, id
        """
    ).fetchall()
    for row in rows:
        ensure_account(conn, row["account"], row["currency"])
        conn.execute(
            """
            insert into entries(transaction_time, type, category, status, amount_cents, currency, transaction_object,
                account, target_account, participant, balance_delta_cents, actual_balance_cents, note)
            values (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["transaction_time"],
                row["type"],
                row["category"],
                row["amount_cents"],
                row["currency"],
                row["transaction_object"],
                row["account"],
                row["target_account"],
                row["participant"],
                row["balance_delta_cents"],
                row["actual_balance_cents"],
                row["note"],
            ),
        )
        update_account_balance(conn, row["account"], row["type"], row["amount_cents"], row["balance_delta_cents"])
        conn.execute("delete from unconfirmed_entries where id = ?", (row["id"],))


def init_db():
    conn = connect()
    conn.executescript(
        """
        create table if not exists accounts (
            id integer primary key autoincrement,
            name text not null unique,
            initial_balance_cents integer not null default 0,
            current_balance_cents integer not null default 0,
            currency text not null default 'CNY',
            note text,
            created_at text not null,
            updated_at text not null
        );

        create table if not exists merchant_category_rules (
            id integer primary key autoincrement,
            merchant text not null unique,
            category text not null,
            type text,
            created_at text not null
        );

        create table if not exists account_debts (
            id integer primary key autoincrement,
            name text not null unique,
            receivable_cents integer not null default 0,
            payable_cents integer not null default 0,
            currency text not null default 'CNY',
            visible integer not null default 1,
            created_at text not null,
            updated_at text not null,
            hidden_at text
        );

        create table if not exists app_settings (
            key text primary key,
            value text,
            updated_at text not null
        );

        create table if not exists counterparty_lists (
            id integer primary key autoincrement,
            kind text not null,
            target_type text not null,
            object_name text,
            entry_id integer,
            label text,
            note text,
            created_at text not null
        );

        create table if not exists counterparty_list_defs (
            id integer primary key autoincrement,
            key text not null unique,
            label text not null,
            sort_order integer not null default 0,
            is_default integer not null default 0,
            hidden integer not null default 0,
            pinned integer not null default 0,
            created_at text not null
        );

        create table if not exists quality_dismissals (
            id integer primary key autoincrement,
            rule text not null,
            entry_id integer not null,
            note text,
            created_at text not null,
            unique(rule, entry_id)
        );

        """
    )
    create_entries_table(conn, "entries")
    create_entries_table(conn, "unconfirmed_entries")
    migrate_table(conn, "entries", ENTRY_COLUMNS)
    migrate_table(conn, "unconfirmed_entries", UNCONFIRMED_COLUMNS)
    conn.execute("drop table if exists import_batches")
    conn.execute("create index if not exists idx_entries_time on entries(transaction_time)")
    conn.execute("create index if not exists idx_entries_category on entries(category)")
    conn.execute("create index if not exists idx_entries_account on entries(account)")
    conn.execute("create index if not exists idx_entries_target_account on entries(target_account)")
    conn.execute("create index if not exists idx_entries_transaction_object on entries(transaction_object)")
    conn.execute("create index if not exists idx_unconfirmed_transaction_object on unconfirmed_entries(transaction_object)")
    conn.execute("create index if not exists idx_account_debts_visible on account_debts(visible)")
    conn.execute("create index if not exists idx_counterparty_lists_kind on counterparty_lists(kind)")
    ensure_list_defs_schema(conn)
    ensure_entries_overlap_schema(conn)
    ensure_default_list_defs(conn)
    migrate_category_only_unconfirmed(conn)
    sync_account_debts_from_entries(conn)
    conn.commit()
    conn.close()


def ensure_account(conn, name, currency="CNY"):
    if not name:
        raise ValueError("account is required")
    row = conn.execute("select id from accounts where name = ?", (name,)).fetchone()
    if row:
        return
    ts = now_iso()
    conn.execute(
        """
        insert into accounts(name, initial_balance_cents, current_balance_cents, currency, created_at, updated_at)
        values (?, 0, 0, ?, ?, ?)
        """,
        (name, currency, ts, ts),
    )


def known_own_account_names(conn):
    names = set(config_account_names())
    names.update(row["name"] for row in conn.execute("select name from accounts").fetchall())
    return names


def set_account(name, balance, currency="CNY", note=None):
    init_db()
    amount = cents(balance)
    ts = now_iso()
    conn = connect()
    conn.execute(
        """
        insert into accounts(name, initial_balance_cents, current_balance_cents, currency, note, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(name) do update set
            initial_balance_cents=excluded.initial_balance_cents,
            current_balance_cents=excluded.current_balance_cents,
            currency=excluded.currency,
            note=excluded.note,
            updated_at=excluded.updated_at
        """,
        (name, amount, amount, currency, note, ts, ts),
    )
    conn.commit()
    conn.close()
    accounts = config_account_names()
    if name not in accounts:
        accounts.append(name)
        write_config_accounts(accounts)


def set_initial_balance(name, amount, note=None):
    """设置账户「期初余额」——只写 accounts.initial_balance_cents，不碰流水的语义。

    ── 语义（务必与界面文案对齐）──────────────────────────────────────────
    * 期初余额 = 账本第一笔流水**之前**该账户里本来有多少钱。本项目第一笔流水
      是 2026-07-07，所以它描述的是 2026-07-07 之前那个时点的余额。
    * 它**不是一条账目**：不产生任何 entries 记录，因此不进收支统计——KPI、
      分类占比、收支趋势、数据质量扫描器统统不受影响，也不会生成余额修正。
    * 期初余额与「余额修正」（type='余额修正'）是**互斥基准**：只要该账户存在
      任意一条 actual_balance_cents 非空的余额修正记录，account_computed_balances()
      就会以最新那条修正为起点重算，期初余额不再参与。这是既有设计，本函数
      不去改动它，只通过返回值的 corrected / balance_basis 明确告诉调用方
      「此刻到底以哪个为基准」，避免用户改了期初却看不到余额变化。

    ── 与 set_account() 的区别（这就是本次要填平的坑）────────────────────
    set_account() 会把 initial_balance_cents 和 current_balance_cents **同时**
    设成同一个值。如果拿它去改一个已有流水的账户的「余额」，下一次重算就变成
    「新值 + 全部流水净额」，余额直接翻倍，并且期初被悄悄改掉，越改越乱。
    本函数只动 initial_balance_cents，current_balance_cents 一律由重算结果
    写回，两者永远不会自相矛盾。

    返回（金额均为「元」字符串，与项目其它接口风格一致）:
        {name, initial_balance, computed_balance, net_flow, changed,
         balance_basis, corrected, balance_basis_time}
    """
    init_db()
    name = str(name or "").strip()
    if not name:
        raise ValueError("account name is required")
    value = cents(amount)
    ts = now_iso()
    conn = connect()
    try:
        row = conn.execute(
            "select id, initial_balance_cents from accounts where name = ?", (name,)
        ).fetchone()
        if not row:
            raise ValueError(f"account not found: {name}")
        changed = int(row["initial_balance_cents"] or 0) != value
        if changed:
            conn.execute(
                "update accounts set initial_balance_cents = ?, updated_at = ? where name = ?",
                (value, ts, name),
            )
            if note:
                conn.execute("update accounts set note = ? where name = ?", (note, name))
        # 期初变了必须立刻重算并把结果同步写回 current_balance_cents，
        # 否则界面上的余额不会跟着变。
        sync_current_balances_from_entries(conn)
        conn.commit()
        result = next(
            (item for item in account_computed_balances(conn) if item["name"] == name), None
        )
    finally:
        conn.close()
    if not result:
        raise ValueError(f"account not found: {name}")
    # net_flow = 「重算基准之后的流水净额」；该账户没有余额修正时，
    # 它就等于账本里该账户全部流水的净额（倒推期初用的正是这个数）。
    net_flow_cents = result["computed_balance_cents"] - result["balance_base_cents"]
    return {
        "name": name,
        "initial_balance": money(result["initial_balance_cents"]),
        "computed_balance": money(result["computed_balance_cents"]),
        "net_flow": money(net_flow_cents),
        "changed": changed,
        "balance_basis": result["balance_basis"],
        "balance_basis_time": result["balance_basis_time"],
        "corrected": result["balance_basis"] == "余额修正",
    }


def initial_fund_candidates(account, days=10, min_amount_cents=50000, end_date=None):
    """只读：扫出该账户「流入方向、单笔金额 ≥ 阈值」的账目，供本金注入改判参考。

    背景：期初余额里的钱通常是开卡后存钱 / 别人汇入，属于「本金注入」而不是劳动收入，
    不该被算进收入统计。但账本里这些钱往往被记成了「收入」或「收款」。

    扫什么：
      * 流入方向：type in ('收入','收款','借入') 且账户就是本账户；
      * 时间窗：最近 `days` 天（默认 10 天）；**`days` 传 0 或负数 = 不限时间、扫全部历史**
        （账户页「定位期初」按钮用的就是这个模式，翻历史找大额流入）；
      * 金额：单笔 ≥ `min_amount_cents`（默认 500 元；「定位期初」面板传 100 元）；
      * type='转账' 且转入账户是本账户的不再列入——它本来就计入余额、不计入收入，
        改判没有意义，列出来只会让用户误操作；
      * type='期初资金' 同样不会被列出（它不在上面那个流入白名单里），避免重复改判。

    两条调用路径的默认值互不影响：
      * 老路径 GET /api/initial-fund-candidates → days 缺省 '10'、min_amount 缺省 '500'
        （设完期初余额后弹的「近 10 天 ≥ 500」提示），行为与之前完全一致；
      * 新路径 GET /api/initial-fund-locate → days 缺省 '0'（全部历史）、min_amount 缺省 '100'
        （账户页每行的「定位期初」按钮）。

    窗口锚点：默认取**该账户最近一条流水的日期**，而不是「今天」。因为记账可能
    停过一段时间（本项目账本停在 2026-10-08），用今天做锚点永远扫不到东西；
    用最近流水日才能真正找到「记账期间发生的大额流入」。可用 end_date 显式覆盖。
    只有 days <= 0（不限时间）时才完全不加日期条件。

    纯 SELECT：不写库、不改任何数据。该账户没有任何流水时返回空数组（正常结果，
    不要为了凑数去放宽条件）。
    """
    init_db()
    account = str(account or "").strip()
    if not account:
        raise ValueError("account is required")
    # days：0 / 空 / 负数 = 不限时间（全部历史）；非法值回退到老默认 10 天
    if days is None or (isinstance(days, str) and not days.strip()):
        parsed_days = 10
    else:
        try:
            parsed_days = int(str(days).strip())
        except (TypeError, ValueError):
            parsed_days = 10
    all_history = parsed_days <= 0
    days = 0 if all_history else max(1, min(parsed_days, 365))
    try:
        min_amount_cents = max(0, int(min_amount_cents or 0))
    except (TypeError, ValueError):
        min_amount_cents = 50000
    conn = connect()
    try:
        known = {row["name"] for row in conn.execute("select name from accounts").fetchall()}
        if account not in known:
            raise ValueError(f"account not found: {account}")
        latest = conn.execute(
            """
            select max(substr(transaction_time, 1, 10)) d from entries
            where account = ? or target_account = ?
            """,
            (account, account),
        ).fetchone()["d"]
        anchor_text = str(end_date or latest or dt.date.today().isoformat())[:10]
        try:
            anchor = dt.date.fromisoformat(anchor_text)
        except ValueError:
            raise ValueError(f"invalid end date: {anchor_text}")
        # 只有一个 SELECT 在真正扫账目；不限时间时连日期条件都不拼，避免参数拼接出错。
        sql = """
            select id, transaction_time, type, category, amount_cents, transaction_object, note, account
            from entries
            where account = ?
              and type in ('收入', '收款', '借入')
        """
        params = [account]
        if all_history:
            window_start = None
            earliest = conn.execute(
                "select min(substr(transaction_time, 1, 10)) d from entries where account = ?",
                (account,),
            ).fetchone()["d"]
        else:
            window_start = anchor - dt.timedelta(days=days)
            sql += " and substr(transaction_time, 1, 10) >= ? and substr(transaction_time, 1, 10) <= ?"
            params += [window_start.isoformat(), anchor.isoformat()]
        sql += " order by transaction_time, id"
        rows = conn.execute(sql, tuple(params)).fetchall()
        # 账本编号：最老 = 1，越新越大，同一时间按 id 升序（与前端 rebuildEntryNumbers 一致）
        entry_numbers = {
            int(row["id"]): index + 1
            for index, row in enumerate(
                conn.execute("select id from entries order by transaction_time, id").fetchall()
            )
        }
    finally:
        conn.close()
    candidates = []
    for row in rows:
        amount = abs(int(row["amount_cents"] or 0))
        if amount < min_amount_cents:
            continue
        candidates.append(
            {
                "id": int(row["id"]),
                "entry_no": entry_numbers.get(int(row["id"])),
                "transaction_time": row["transaction_time"],
                "type": row["type"],
                "amount_cents": amount,
                "amount": money(amount),
                "category": row["category"],
                "transaction_object": row["transaction_object"],
                "note": row["note"],
                "account": row["account"],
            }
        )
    return {
        "account": account,
        "days": days,
        "all_history": all_history,
        "min_amount_cents": min_amount_cents,
        "min_amount": money(min_amount_cents),
        # 不限时间时 window_start 取该账户最早一条流水（早于它就什么都没有，等价于「全部历史」）
        "window_start": (earliest if all_history else window_start.isoformat()),
        "window_end": (None if all_history else anchor.isoformat()),
        "anchor_basis": (
            "全部历史（不限时间）"
            if all_history
            else ("指定日期" if end_date else ("该账户最近一条流水的日期" if latest else "今天"))
        ),
        "count": len(candidates),
        "candidates": candidates,
    }


def mark_entries_as_initial_fund(entry_ids):
    """把选中的账目 type 改成「期初资金」（本金注入）。**只由用户勾选确认后调用，绝不自动执行。**

    只接受流入方向（收入 / 收款 / 借入）的账目：
      * 这三种的 BALANCE_SIGNS 都是 +1，期初资金也是 +1，所以改判后
        account_balance_delta() 的结果完全不变 —— **账户余额一分钱都不动**，
        变的只是统计口径（不再计入收入）。
      * 支出 / 借出 / 还款 改判没有意义，直接跳过并在 skipped 里说明原因。
      * 已经是期初资金的跳过，不重复计数。
      * 转账 / 余额修正本来就不计入收入，也跳过。

    改判后分类清空（期初资金不需要分类），状态置为已确认，避免它掉进待确认列表。
    """
    ids = []
    for value in entry_ids or []:
        try:
            ids.append(int(value))
        except (TypeError, ValueError):
            continue
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise ValueError("entry_ids is required")
    init_db()
    conn = connect()
    changed, skipped, months = [], [], {}
    try:
        holes = ",".join("?" for _ in ids)
        found = {int(row["id"]): row for row in conn.execute(f"select * from entries where id in ({holes})", tuple(ids)).fetchall()}
        for entry_id in ids:
            row = found.get(entry_id)
            if not row:
                skipped.append({"id": entry_id, "reason": "账目不存在"})
                continue
            if row["type"] == "期初资金":
                skipped.append({"id": entry_id, "reason": "已经是期初资金"})
                continue
            if row["type"] not in ("收入", "收款", "借入"):
                skipped.append({"id": entry_id, "reason": f"只有流入方向的账目改判才有意义（当前 type={row['type']}）"})
                continue
            conn.execute(
                "update entries set type = ?, category = NULL, status = 'confirmed' where id = ?",
                ("期初资金", entry_id),
            )
            month = str(row["transaction_time"] or "")[:7]
            months[month] = months.get(month, 0) + abs(int(row["amount_cents"] or 0))
            changed.append(entry_id)
        # 余额表按流水重算并写回：期初资金与收入同向，所以数值不变，这里只是保证一致。
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
    finally:
        conn.close()
    removed_cents = sum(months.values())
    return {
        "ok": True,
        "changed": changed,
        "changed_count": len(changed),
        "skipped": skipped,
        "removed_income_cents": removed_cents,
        "removed_income": money(removed_cents),
        "removed_income_by_month": {month: money(value) for month, value in sorted(months.items())},
        "balance_unchanged": True,
    }


def flatten_categories():
    if not CONFIG_PATH.exists():
        return []
    categories = []
    stack = []
    in_categories = False
    for raw in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or raw.lstrip().startswith("#"):
            continue
        if len(raw) == len(raw.lstrip(" ")) and stripped.endswith(":"):
            in_categories = stripped == "categories:"
            stack = []
            continue
        if not in_categories:
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        text = stripped
        level = indent // 2
        if text.startswith("- "):
            item = text[2:].strip()
            prefix = stack[-1][1] if stack else ""
            categories.append(f"{prefix}/{item}" if prefix else item)
            continue
        key = text.split(":", 1)[0].strip().strip('"').strip("'")
        stack = [s for s in stack if s[0] < level]
        if level >= 1:
            if stack and stack[-1][0] == level - 1 and stack[-1][1] in {"支出", "收入", "转账", "借入", "借出", "还款", "收款"}:
                value = key
            elif stack and stack[-1][1] not in {"支出", "收入", "转账", "借入", "借出", "还款", "收款"}:
                value = f"{stack[-1][1]}/{key}"
            else:
                value = key
            stack.append((level, value))
            if text.endswith("[]"):
                categories.append(value)
    return sorted(set(categories))


def category_tree():
    if not CONFIG_PATH.exists():
        return {}
    tree = {}
    current_type = None
    current_group = None
    in_categories = False
    for raw in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or raw.lstrip().startswith("#"):
            continue
        if len(raw) == len(raw.lstrip(" ")) and stripped.endswith(":"):
            in_categories = stripped == "categories:"
            current_type = None
            current_group = None
            continue
        if not in_categories:
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        text = stripped
        if indent == 2 and text.endswith(":"):
            current_type = text[:-1].strip().strip('"').strip("'")
            current_group = None
            tree.setdefault(current_type, {})
        elif indent == 4 and current_type:
            key = text.split(":", 1)[0].strip().strip('"').strip("'")
            current_group = key
            tree[current_type].setdefault(current_group, [])
        elif indent == 6 and current_type and current_group and text.startswith("- "):
            tree[current_type][current_group].append(text[2:].strip())
    return tree


def config_account_names():
    if not CONFIG_PATH.exists():
        return []
    names = []
    in_accounts = False
    for raw in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or raw.lstrip().startswith("#"):
            continue
        if len(raw) == len(raw.lstrip(" ")) and stripped.endswith(":"):
            in_accounts = stripped == "accounts:"
            continue
        if in_accounts and stripped.startswith("- "):
            names.append(stripped[2:].strip())
    return names


def account_names():
    init_db()
    conn = connect()
    names = {row["name"] for row in conn.execute("select name from accounts").fetchall()}
    conn.close()
    return sorted(names)


def historical_account_names():
    init_db()
    conn = connect()
    names = set(account_names())
    for sql in [
        "select distinct account name from entries where account != ''",
        "select distinct target_account name from entries where target_account is not null and target_account != ''",
        "select distinct account name from unconfirmed_entries where account != ''",
        "select distinct target_account name from unconfirmed_entries where target_account is not null and target_account != ''",
    ]:
        names.update(row["name"] for row in conn.execute(sql).fetchall())
    conn.close()
    return sorted(names)


def add_account_name(name):
    name = str(name or "").strip()
    if not name:
        raise ValueError("account name is required")
    init_db()
    conn = connect()
    try:
        ensure_account(conn, name)
        conn.commit()
    finally:
        conn.close()
    accounts = config_account_names()
    if name not in accounts:
        accounts.append(name)
        write_config_accounts(accounts)


def write_config_accounts(accounts):
    seen = set()
    clean_accounts = []
    for account in accounts:
        account = str(account or "").strip()
        if account and account not in seen:
            seen.add(account)
            clean_accounts.append(account)
    lines = CONFIG_PATH.read_text(encoding="utf-8").splitlines() if CONFIG_PATH.exists() else []
    account_header = next((i for i, line in enumerate(lines) if line.strip() == "accounts:" and not line.startswith(" ")), None)
    if account_header is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("accounts:")
        lines.extend(f"  - {name}" for name in clean_accounts)
    else:
        end = account_header + 1
        while end < len(lines) and (lines[end].startswith(" ") or not lines[end].strip()):
            end += 1
        lines = lines[:account_header + 1] + [f"  - {name}" for name in clean_accounts] + lines[end:]
    CONFIG_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def rename_account_name(old_name, new_name):
    old_name = str(old_name or "").strip()
    new_name = str(new_name or "").strip()
    if not old_name or not new_name:
        raise ValueError("account name is required")
    if old_name == new_name:
        return {"ok": True}
    if new_name in set(account_names()):
        raise ValueError("account already exists")
    init_db()
    conn = connect()
    try:
        row = conn.execute("select id from accounts where name = ?", (old_name,)).fetchone()
        if row:
            conn.execute("update accounts set name = ?, updated_at = ? where name = ?", (new_name, now_iso(), old_name))
        else:
            ensure_account(conn, new_name)
        conn.execute("update entries set account = ? where account = ?", (new_name, old_name))
        conn.execute("update entries set target_account = ? where target_account = ?", (new_name, old_name))
        conn.execute("update unconfirmed_entries set account = ? where account = ?", (new_name, old_name))
        conn.execute("update unconfirmed_entries set target_account = ? where target_account = ?", (new_name, old_name))
        conn.commit()
    finally:
        conn.close()

    accounts = [new_name if account == old_name else account for account in config_account_names()]
    if new_name not in accounts:
        accounts.append(new_name)
    write_config_accounts(accounts)
    return {"ok": True}


def delete_account_name(name):
    name = str(name or "").strip()
    if not name:
        raise ValueError("account name is required")
    init_db()
    conn = connect()
    try:
        conn.execute("delete from accounts where name = ?", (name,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


def add_category(tx_type, category):
    tx_type = str(tx_type or "").strip()
    category = str(category or "").strip().strip("/")
    if tx_type not in ENTRY_TYPES:
        raise ValueError("invalid type")
    if not category:
        raise ValueError("category is required")
    tree = category_tree()
    existing = set(flatten_categories())
    if category in existing:
        return
    parts = [p.strip() for p in category.split("/", 1)]
    group = parts[0]
    leaf = parts[1] if len(parts) > 1 and parts[1] else None
    lines = CONFIG_PATH.read_text(encoding="utf-8").splitlines() if CONFIG_PATH.exists() else ["categories:"]
    type_header = next((i for i, line in enumerate(lines) if line == f"  {tx_type}:"), None)
    if type_header is None:
        lines.append("")
        lines.append(f"  {tx_type}:")
        type_header = len(lines) - 1
    type_end = type_header + 1
    while type_end < len(lines) and not (lines[type_end].startswith("  ") and not lines[type_end].startswith("    ") and lines[type_end].strip().endswith(":")):
        if lines[type_end] and not lines[type_end].startswith(" "):
            break
        type_end += 1
    if leaf is None:
        lines.insert(type_end, f"    {group}: []")
    else:
        group_line = next((i for i in range(type_header + 1, type_end) if lines[i].startswith("    ") and lines[i].strip().split(":", 1)[0] == group), None)
        if group_line is None:
            lines.insert(type_end, f"    {group}:")
            lines.insert(type_end + 1, f"      - {leaf}")
        elif lines[group_line].strip().endswith("[]"):
            lines[group_line] = f"    {group}:"
            lines.insert(group_line + 1, f"      - {leaf}")
        else:
            insert_at = group_line + 1
            while insert_at < type_end and lines[insert_at].startswith("      "):
                insert_at += 1
            lines.insert(insert_at, f"      - {leaf}")
    CONFIG_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _set_category_path(tree, tx_type, category):
    parts = [p.strip() for p in str(category or "").strip().strip("/").split("/", 1)]
    group = parts[0] if parts else ""
    leaf = parts[1] if len(parts) > 1 and parts[1] else None
    if not group:
        raise ValueError("category is required")
    type_tree = tree.setdefault(tx_type, {})
    leaves = type_tree.setdefault(group, [])
    if leaf and leaf not in leaves:
        leaves.append(leaf)


def _category_parts(category):
    parts = [p.strip() for p in str(category or "").strip().strip("/").split("/", 1)]
    group = parts[0] if parts else ""
    leaf = parts[1] if len(parts) > 1 and parts[1] else None
    return group, leaf


def _affected_category_names(tree, tx_type, category):
    """返回该分类（大分类或小分类）影响到的、数据库中实际出现的分类名。"""
    group, leaf = _category_parts(category)
    type_tree = tree.get(tx_type) or {}
    if not group or group not in type_tree:
        raise ValueError("category not found")
    if leaf:
        if leaf not in type_tree[group]:
            raise ValueError("category not found")
        return [f"{group}/{leaf}"]
    leaves = type_tree[group]
    if leaves:
        return [f"{group}/{item}" for item in leaves]
    return [group]


def _remove_category_path(tree, tx_type, category):
    group, leaf = _category_parts(category)
    if not group:
        raise ValueError("category is required")
    type_tree = tree.get(tx_type) or {}
    if group not in type_tree:
        raise ValueError("category not found")
    if leaf:
        leaves = type_tree[group]
        if leaf not in leaves:
            raise ValueError("category not found")
        leaves.remove(leaf)
        if not leaves:
            del type_tree[group]
    else:
        del type_tree[group]


def _write_category_tree(tree):
    accounts = config_account_names()
    lines = ["categories:"]
    for tx_type, groups in tree.items():
        lines.append(f"  {tx_type}:")
        for group, leaves in groups.items():
            if leaves:
                lines.append(f"    {group}:")
                lines.extend(f"      - {leaf}" for leaf in leaves)
            else:
                lines.append(f"    {group}: []")
        lines.append("")
    lines.append("accounts:")
    lines.extend(f"  - {name}" for name in accounts)
    CONFIG_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def delete_category(tx_type, category):
    """删除分类。大分类会连同其下所有小分类一起删除。"""
    tx_type = str(tx_type or "").strip()
    category = str(category or "").strip().strip("/")
    if tx_type not in ENTRY_TYPES:
        raise ValueError("invalid type")
    if not category:
        raise ValueError("category is required")
    tree = category_tree()
    names = _affected_category_names(tree, tx_type, category)
    _remove_category_path(tree, tx_type, category)
    _write_category_tree(tree)
    init_db()
    conn = connect()
    try:
        holes = ",".join("?" for _ in names)
        conn.execute(
            f"delete from merchant_category_rules where category in ({holes}) and coalesce(type, ?) = ?",
            (*names, tx_type, tx_type),
        )
        cur = conn.execute(
            f"update entries set category = null, status = 'pending' where type = ? and category in ({holes})",
            (tx_type, *names),
        )
        affected = max(cur.rowcount or 0, 0)
        conn.execute(
            f"update unconfirmed_entries set category = null where type = ? and category in ({holes})",
            (tx_type, *names),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "affected_entries": affected, "removed": names}


def rename_category(tx_type, old_category, new_category):
    """重命名分类。重命名大分类时，其下所有小分类与已归类的账目一起跟着改。"""
    tx_type = str(tx_type or "").strip()
    old_category = str(old_category or "").strip().strip("/")
    new_category = str(new_category or "").strip().strip("/")
    if tx_type not in ENTRY_TYPES:
        raise ValueError("invalid type")
    if not old_category or not new_category:
        raise ValueError("category is required")

    tree = category_tree()
    old_group, old_leaf = _category_parts(old_category)
    new_group, new_leaf = _category_parts(new_category)
    type_tree = tree.setdefault(tx_type, {})
    if old_group not in type_tree:
        raise ValueError("category not found")
    old_leaves = type_tree[old_group]
    if old_leaf is not None and old_leaf not in old_leaves:
        raise ValueError("category not found")

    if old_leaf is None:
        if new_leaf is not None:
            raise ValueError("大分类名称里不能带 /")
        if new_group == old_group:
            return {"ok": True, "renamed": {}}
        if new_group in type_tree:
            raise ValueError("分类已存在")
        renamed = {}
        for group, leaves in type_tree.items():
            renamed[new_group if group == old_group else group] = list(leaves)
        tree[tx_type] = renamed
        mapping = {f"{old_group}/{leaf}": f"{new_group}/{leaf}" for leaf in old_leaves}
        if not old_leaves:
            mapping[old_group] = new_group
    else:
        if new_leaf is None:
            raise ValueError("小分类要写成 大分类/小分类")
        if new_group == old_group and new_leaf == old_leaf:
            return {"ok": True, "renamed": {}}
        if new_group in type_tree and new_leaf in type_tree[new_group]:
            raise ValueError("分类已存在")
        old_leaves.remove(old_leaf)
        if not old_leaves:
            del type_tree[old_group]
        type_tree.setdefault(new_group, [])
        if new_leaf not in type_tree[new_group]:
            type_tree[new_group].append(new_leaf)
        mapping = {f"{old_group}/{old_leaf}": f"{new_group}/{new_leaf}"}

    _write_category_tree(tree)
    init_db()
    conn = connect()
    try:
        for old_name, new_name in mapping.items():
            conn.execute("update entries set category = ? where category = ? and type = ?", (new_name, old_name, tx_type))
            conn.execute("update unconfirmed_entries set category = ? where category = ? and type = ?", (new_name, old_name, tx_type))
            conn.execute(
                "update merchant_category_rules set category = ? where category = ? and coalesce(type, ?) = ?",
                (new_name, old_name, tx_type, tx_type),
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "renamed": mapping}


def categories_for_type(tree, tx_type):
    groups = tree.get(tx_type) or {}
    categories = []
    for group, leaves in groups.items():
        if leaves:
            categories.extend(f"{group}/{leaf}" for leaf in leaves)
        else:
            categories.append(group)
    return categories


def valid_categories():
    return set(flatten_categories()) | {"转账", "余额修正"}


def standardize_category(category, tx_type=None):
    _, _, path = parse_category_path(category)
    if not path:
        return None
    valid = valid_categories()
    if path in valid:
        return path
    if tx_type == "转账" and path == "转账":
        return "转账"
    return None


def apply_learned_rule(conn, record):
    if record.get("category"):
        return record
    candidates = conn.execute(
        "select merchant, category, type from merchant_category_rules order by length(merchant) desc"
    ).fetchall()
    rule = match_rule_in_text(candidates, record.get("transaction_object"))
    if not rule:
        rule = match_rule_in_text(candidates, record.get("note"))
    if rule:
        record["category"] = rule["category"]
        if rule["type"]:
            record["type"] = rule["type"]
    return record


def match_rule_in_text(candidates, value):
    text = str(value or "").strip()
    if not text:
        return None
    return next((candidate for candidate in candidates if candidate["merchant"] and candidate["merchant"] in text), None)


def normalize_record(conn, record, apply_rules=True):
    record = dict(record)
    record["transaction_object"] = record.get("transaction_object") or record.get("merchant") or record.get("counterparty")
    record["transaction_time"] = record.get("transaction_time") or now_iso()
    record["currency"] = record.get("currency") or "CNY"
    record["participant"] = record.get("participant") or "自己"
    record["target_account"] = record.get("target_account") or record.get("to_account") or record.get("transfer_account")
    record["type"] = record.get("type")
    if record["type"] and record["type"] not in ENTRY_TYPES:
        record["type"] = None
    if record["type"] == "转账":
        record["category"] = "转账"
    if not record.get("category") and record.get("category_level1"):
        level1 = str(record.get("category_level1") or "").strip()
        level2 = str(record.get("category_level2") or "").strip()
        record["category"] = f"{level1}/{level2}" if level2 else level1
    if apply_rules and auto_apply_rules_enabled():
        record = apply_learned_rule(conn, record)
    record["category"] = standardize_category(record.get("category"), record.get("type"))
    return record


def update_account_balance(conn, account, tx_type, amount_cents, balance_delta_cents=None):
    delta = account_balance_delta(tx_type, amount_cents, balance_delta_cents)
    if delta is None:
        return
    ensure_account(conn, account)
    conn.execute(
        "update accounts set current_balance_cents = current_balance_cents + ?, updated_at = ? where name = ?",
        (delta, now_iso(), account),
    )


def debt_party_name(row):
    name = str(row["transaction_object"] or row["participant"] or "").strip()
    return name or "未指定对象"


def sync_account_debts_from_entries(conn):
    rows = conn.execute(
        """
        select type, amount_cents, transaction_object, participant
        from entries
        where type in ('借出', '收款', '借入', '还款')
        """
    ).fetchall()
    totals = {}
    for row in rows:
        name = debt_party_name(row)
        current = totals.setdefault(name, {"receivable_cents": 0, "payable_cents": 0})
        amount = int(row["amount_cents"] or 0)
        if row["type"] == "借出":
            current["receivable_cents"] += amount
        elif row["type"] == "收款":
            current["receivable_cents"] -= amount
        elif row["type"] == "借入":
            current["payable_cents"] += amount
        elif row["type"] == "还款":
            current["payable_cents"] -= amount

    ts = now_iso()
    for name, total in totals.items():
        receivable = max(0, total["receivable_cents"])
        payable = max(0, total["payable_cents"])
        conn.execute(
            """
            insert into account_debts(name, receivable_cents, payable_cents, currency, visible, created_at, updated_at)
            values (?, ?, ?, 'CNY', 1, ?, ?)
            on conflict(name) do update set
                receivable_cents = excluded.receivable_cents,
                payable_cents = excluded.payable_cents,
                updated_at = excluded.updated_at
            """,
            (name, receivable, payable, ts, ts),
        )

    existing_names = set(totals)
    if existing_names:
        placeholders = ",".join("?" for _ in existing_names)
        conn.execute(
            f"""
            update account_debts
            set receivable_cents = 0, payable_cents = 0, updated_at = ?
            where name not in ({placeholders})
            """,
            (ts, *existing_names),
        )
    else:
        conn.execute("update account_debts set receivable_cents = 0, payable_cents = 0, updated_at = ?", (ts,))


def list_account_debts(conn):
    return rows_to_dicts(
        conn.execute(
            """
            select id, name, receivable_cents, payable_cents, currency, updated_at
            from account_debts
            where visible = 1 and (receivable_cents != 0 or payable_cents != 0)
            order by (receivable_cents + payable_cents) desc, name
            """
        ).fetchall()
    )


def hide_account_debt(debt_id):
    init_db()
    conn = connect()
    try:
        row = conn.execute("select id from account_debts where id = ?", (debt_id,)).fetchone()
        if not row:
            raise ValueError(f"debt row not found: {debt_id}")
        ts = now_iso()
        conn.execute(
            "update account_debts set visible = 0, hidden_at = ?, updated_at = ? where id = ?",
            (ts, ts, debt_id),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def is_internal_transfer_record(conn, record):
    if record.get("type") != "转账":
        return False
    account = str(record.get("account") or "").strip()
    target_account = str(record.get("target_account") or "").strip()
    if not account or not target_account or account == target_account:
        return False
    own_accounts = known_own_account_names(conn)
    return account in own_accounts and target_account in own_accounts


def insert_entry(record, auto_learn=False, raw_payload=None):
    init_db()
    conn = connect()
    try:
        result = insert_entry_with_conn(conn, record, auto_learn=auto_learn, raw_payload=raw_payload)
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
        return result
    finally:
        conn.close()


def insert_entry_with_conn(conn, record, auto_learn=False, raw_payload=None):
    record = normalize_record(conn, record)
    raw_amount_cents = cents(record.get("amount"))
    amount_cents = abs(raw_amount_cents)
    if record.get("type") == "余额修正" and record.get("balance_delta_cents") in (None, ""):
        record["balance_delta_cents"] = raw_amount_cents
    required_missing = not record.get("account") or not record.get("type") or not amount_cents
    if record.get("type") == "转账" and not record.get("target_account"):
        required_missing = True
    if record.get("type") == "转账" and record.get("target_account") and not is_internal_transfer_record(conn, record):
        required_missing = True
    if record.get("type") == "转账" and record.get("account") == record.get("target_account"):
        raise ValueError("transfer target_account must differ from account")
    needs_category = record.get("type") not in NON_REPORTING_TYPES and not record.get("category")
    if required_missing:
        conn.execute(
            """
            insert into unconfirmed_entries(transaction_time, type, category, amount_cents, currency, transaction_object,
                status, account, target_account, participant, balance_delta_cents, actual_balance_cents,
                note, raw_payload)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record["transaction_time"],
                record.get("type"),
                record.get("category"),
                amount_cents,
                record["currency"],
                record.get("transaction_object"),
                "pending",
                record.get("account") or "",
                record.get("target_account"),
                record["participant"],
                record.get("balance_delta_cents"),
                record.get("actual_balance_cents"),
                record.get("note"),
                json.dumps(raw_payload or record, ensure_ascii=False),
            ),
        )
        return {"status": "unconfirmed", "id": conn.execute("select last_insert_rowid()").fetchone()[0]}
    status = "pending" if needs_category else "confirmed"
    ensure_account(conn, record["account"], record["currency"])
    if record.get("type") == "转账":
        ensure_account(conn, record["target_account"], record["currency"])
    conn.execute(
        """
        insert into entries(transaction_time, type, category, status, amount_cents, currency, transaction_object, account,
            target_account, participant, balance_delta_cents, actual_balance_cents, note)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["transaction_time"],
            record["type"],
            record.get("category"),
            status,
            amount_cents,
            record["currency"],
            record.get("transaction_object"),
            record["account"],
            record.get("target_account"),
            record["participant"],
            record.get("balance_delta_cents"),
            record.get("actual_balance_cents"),
            record.get("note"),
        ),
    )
    entry_id = conn.execute("select last_insert_rowid()").fetchone()[0]
    update_account_balance(conn, record["account"], record["type"], amount_cents, record.get("balance_delta_cents"))
    if record.get("type") == "转账":
        update_account_balance(conn, record["target_account"], "收入", amount_cents)
    if auto_learn and record.get("transaction_object") and record.get("category"):
        add_rule(conn, record["transaction_object"], record["category"], record.get("type"))
    return {"status": status, "id": entry_id}


def add_rule(conn, merchant, category, tx_type=None):
    merchant = str(merchant or "").strip()
    category = standardize_category(category, tx_type)
    if not merchant:
        raise ValueError("keyword is required")
    if not category:
        raise ValueError("valid category is required")
    if tx_type and tx_type not in ENTRY_TYPES:
        raise ValueError("invalid type")
    conn.execute(
        """
        insert into merchant_category_rules(merchant, category, type, created_at)
        values (?, ?, ?, ?)
        on conflict(merchant) do update set category=excluded.category, type=excluded.type
        """,
        (merchant, category, tx_type, now_iso()),
    )


def list_keyword_rules():
    init_db()
    conn = connect()
    rows = rows_to_dicts(
        conn.execute(
            """
            select id, merchant keyword, category, type, created_at
            from merchant_category_rules
            order by coalesce(type, ''), category, keyword
            """
        ).fetchall()
    )
    conn.close()
    return rows


def add_keyword_rule(keyword, category, tx_type=None):
    init_db()
    conn = connect()
    try:
        add_rule(conn, keyword, category, tx_type)
        conn.commit()
        row = conn.execute(
            "select id, merchant keyword, category, type, created_at from merchant_category_rules where merchant = ?",
            (str(keyword or "").strip(),),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


def apply_keyword_rule_to_unconfirmed(keyword, category, tx_type=None):
    keyword = str(keyword or "").strip()
    if not keyword:
        return {"applied": 0, "ids": []}
    category = standardize_category(category, tx_type)
    if not category:
        raise ValueError("valid category is required")
    init_db()
    conn = connect()
    try:
        candidates = [{"merchant": keyword, "category": category, "type": tx_type}]
        pending_rows = [
            row for row in conn.execute("select * from entries where status = 'pending' order by transaction_time, id").fetchall()
            if match_rule_in_text(candidates, row["transaction_object"]) or match_rule_in_text(candidates, row["note"])
        ]
        rows = [
            row for row in conn.execute("select * from unconfirmed_entries order by transaction_time, id").fetchall()
            if match_rule_in_text(candidates, row["transaction_object"]) or match_rule_in_text(candidates, row["note"])
        ]
        ids = [row["id"] for row in rows]
        if ids:
            conn.execute(
                f"delete from unconfirmed_entries where id in ({', '.join('?' for _ in ids)})",
                tuple(ids),
            )
        conn.commit()
    finally:
        conn.close()
    applied_ids = []
    for row in pending_rows:
        result = confirm_pending_entry(row["id"], category, tx_type)
        if result:
            applied_ids.append(result["id"])
    for row in rows:
        record = dict(row)
        record["category"] = category
        if tx_type:
            record["type"] = tx_type
        record["amount"] = money(record.pop("amount_cents"))
        result = insert_entry(record, raw_payload=parse_attributes(record.get("raw_payload")) or record)
        if result["status"] == "confirmed":
            applied_ids.append(result["id"])
    return {"applied": len(applied_ids), "ids": applied_ids}


def apply_all_keyword_rules_to_unconfirmed():
    init_db()
    conn = connect()
    try:
        candidates = conn.execute(
            "select merchant, category, type from merchant_category_rules order by length(merchant) desc"
        ).fetchall()
        pending_rows = conn.execute("select * from entries where status = 'pending' order by transaction_time, id").fetchall()
        pending_matches = []
        for row in pending_rows:
            rule = match_rule_in_text(candidates, row["transaction_object"]) or match_rule_in_text(candidates, row["note"])
            if rule:
                pending_matches.append((row, rule))
        rows = conn.execute("select * from unconfirmed_entries order by transaction_time, id").fetchall()
        matches = []
        for row in rows:
            rule = match_rule_in_text(candidates, row["transaction_object"]) or match_rule_in_text(candidates, row["note"])
            if rule:
                matches.append((row, rule))
        ids = [row["id"] for row, _ in matches]
        if ids:
            conn.execute(
                f"delete from unconfirmed_entries where id in ({', '.join('?' for _ in ids)})",
                tuple(ids),
            )
        conn.commit()
    finally:
        conn.close()
    applied_ids = []
    for row, rule in pending_matches:
        result = confirm_pending_entry(row["id"], rule["category"], rule["type"])
        if result:
            applied_ids.append(result["id"])
    for row, rule in matches:
        record = dict(row)
        record["category"] = rule["category"]
        if rule["type"]:
            record["type"] = rule["type"]
        record["amount"] = money(record.pop("amount_cents"))
        result = insert_entry(record, raw_payload=parse_attributes(record.get("raw_payload")) or record)
        if result["status"] == "confirmed":
            applied_ids.append(result["id"])
    return {"applied": len(applied_ids), "ids": applied_ids}


def add_keyword_rule_and_apply(keyword, category, tx_type=None):
    rule = add_keyword_rule(keyword, category, tx_type)
    result = apply_keyword_rule_to_unconfirmed(keyword, category, tx_type)
    rule["applied_unconfirmed"] = result["applied"]
    rule["applied_entry_ids"] = result["ids"]
    return rule


def delete_keyword_rule(rule_id):
    init_db()
    conn = connect()
    try:
        conn.execute("delete from merchant_category_rules where id = ?", (rule_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


DEFAULT_SETTINGS = {"auto_apply_rules": "1"}
_SETTINGS_CACHE = {}
# 名单默认定义：key 必须保持不变，否则会丢掉既有的 counterparty_lists 数据
DEFAULT_LIST_DEFS = (
    ("whitelist", "白名单", 10, 1),
    ("large", "大额名单", 20, 1),
)
# 交互消费统计顶部快捷位数量 & 置顶上限
LIST_PIN_LIMIT = 3
LIST_KINDS = {key for key, _label, _order, _is_default in DEFAULT_LIST_DEFS}


def get_setting(key, default=None):
    key = str(key or "")
    init_db()
    conn = connect()
    try:
        row = conn.execute("select value from app_settings where key = ?", (key,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return DEFAULT_SETTINGS.get(key, default)
    return row["value"]


def set_setting(key, value):
    key = str(key or "").strip()
    if key not in DEFAULT_SETTINGS:
        raise ValueError("unknown setting")
    stored = "1" if value in (True, 1, "1", "true", "True", "on", "yes") else "0"
    init_db()
    conn = connect()
    try:
        conn.execute(
            "insert into app_settings(key, value, updated_at) values (?, ?, ?) "
            "on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
            (key, stored, now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    _SETTINGS_CACHE.pop(key, None)
    return {"ok": True, "key": key, "value": stored}


def settings_snapshot():
    data = {key: (value == "1") for key, value in DEFAULT_SETTINGS.items()}
    init_db()
    conn = connect()
    try:
        for row in conn.execute("select key, value from app_settings").fetchall():
            if row["key"] in DEFAULT_SETTINGS:
                data[row["key"]] = row["value"] == "1"
    finally:
        conn.close()
    return data


def _bill_import_module():
    """惰性加载账单导入模块（解析 PDF 的依赖只在真正导入时才用）。"""
    if str(SCRIPTS_PATH) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_PATH))
    import importlib
    return importlib.import_module("bill_import")


def _import_target_dir(payload):
    raw = str((payload or {}).get("path") or "").strip()
    return raw or DEFAULT_IMPORT_DIR


def _import_account_mapping(payload):
    """从 payload 里取「账户对应」映射：{"账单账户标识": "本地账户名"}。

    这是用户在前端下拉里确认过的结果；没传就返回 {}，导入会走解析阶段的
    自动推导 + BILL_ACC_* 环境变量兜底（老行为完全不变）。
    """
    raw = (payload or {}).get("account_mapping")
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, value in raw.items():
        k = str(key or "").strip()
        v = str(value or "").strip()
        if k and v:
            out[k] = v
    return out


def import_preview(payload=None):
    """POST /api/import-preview —— 只读预览，绝不写库、不写文件。"""
    payload = payload or {}
    src = _import_target_dir(payload)
    near = int(payload.get("near") or 300)
    mapping = _import_account_mapping(payload)
    mod = _bill_import_module()
    result = mod.preview_import(src, db_path=str(DB_PATH), near=near,
                                account_mapping=mapping or None)
    result["default_dir"] = DEFAULT_IMPORT_DIR
    return result


def import_execute(payload=None):
    """POST /api/import-execute —— 默认只预览；preview_only=False 才真写库（先自动备份）。"""
    payload = payload or {}
    src = _import_target_dir(payload)
    near = int(payload.get("near") or 300)
    mapping = _import_account_mapping(payload)
    preview_only = payload.get("preview_only")
    if preview_only is None:
        preview_only = True                      # 默认 dry-run
    elif isinstance(preview_only, str):
        preview_only = preview_only.strip().lower() not in ("false", "0", "no", "")
    else:
        preview_only = bool(preview_only)
    mod = _bill_import_module()
    backup_dir = str(DB_PATH.resolve().parents[1] / "_备份")
    return mod.execute_import(
        src, db_path=str(DB_PATH), near=near,
        preview_only=preview_only, backup_dir=backup_dir,
        account_mapping=mapping or None)


def auto_apply_rules_enabled():
    if "auto_apply_rules" not in _SETTINGS_CACHE:
        try:
            _SETTINGS_CACHE["auto_apply_rules"] = get_setting("auto_apply_rules", "1") == "1"
        except Exception:
            _SETTINGS_CACHE["auto_apply_rules"] = True
    return _SETTINGS_CACHE["auto_apply_rules"]


def ensure_entries_overlap_schema(conn):
    """幂等迁移：老库里的 entries / unconfirmed_entries 缺 overlap_flag 列就补上。

    跨来源重复在库里是**结构化属性**（不是备注文字）：1 = 该条目在另一个来源里
    存在疑似同一笔的流水。默认 0。
    只在「列不存在」时 ALTER 一次，所以重复启动不会重复加列，也不会把导入脚本
    已经标记好的 1 重置掉。
    """
    for table in ("entries", "unconfirmed_entries"):
        try:
            columns = [row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()]
        except sqlite3.Error:
            continue
        if not columns:
            continue
        if "overlap_flag" not in columns:
            conn.execute(
                f"alter table {table} add column overlap_flag integer not null default 0"
            )


def ensure_list_defs_schema(conn):
    """幂等迁移：老库里的 counterparty_list_defs 缺 hidden / pinned 列就补上。

    只在「列不存在」时 ALTER 一次，所以重复启动不会重复加列，也不会把用户
    后来改过的 pinned 状态重置掉。
    """
    try:
        columns = [row["name"] for row in conn.execute("pragma table_info(counterparty_list_defs)").fetchall()]
    except sqlite3.Error:
        return
    if not columns:
        return
    if "hidden" not in columns:
        conn.execute("alter table counterparty_list_defs add column hidden integer not null default 0")
    if "pinned" not in columns:
        conn.execute("alter table counterparty_list_defs add column pinned integer not null default 0")
        # 首次加列时：白名单 / 大额名单默认为已置顶，其他名单默认不置顶
        conn.execute(
            "update counterparty_list_defs set pinned = 1 where key in ('whitelist', 'large')"
        )


def ensure_default_list_defs(conn):
    """幂等：补齐 whitelist / large 两条默认记录；已存在（含被删除的墓碑）一律不动。

    先查再插，而不是无条件 `insert or ignore`。原因：init_db() 在每个 API 请求里都会跑一遍，
    而 `insert or ignore` 即使命中的是唯一键冲突、一行都没写进去，SQLite 也会提交一次写事务、
    把文件头的 change counter 推进一格。于是每开一次看板页面（12 个接口）数据库文件就被改写
    二十多次，备份 / 云同步 / 杀毒会反复认为这份库变了。已存在时干脆一条语句都不执行。
    """
    existing = {row[0] for row in conn.execute("select key from counterparty_list_defs").fetchall()}
    pending = [item for item in DEFAULT_LIST_DEFS if item[0] not in existing]
    if not pending:
        return
    ts = now_iso()
    for key, label, order, is_default in pending:
        conn.execute(
            "insert or ignore into counterparty_list_defs"
            "(key, label, sort_order, is_default, hidden, pinned, created_at) "
            "values (?, ?, ?, ?, 0, 1, ?)",
            (key, label, order, is_default, ts),
        )


def list_defs():
    """当前可见的名单定义（不含已删除的墓碑记录）。"""
    init_db()
    conn = connect()
    try:
        return rows_to_dicts(conn.execute(
            "select id, key, label, sort_order, is_default, pinned from counterparty_list_defs "
            "where coalesce(hidden, 0) = 0 order by sort_order, id"
        ).fetchall())
    finally:
        conn.close()


def list_defs_with_counts():
    """名单定义 + 每个名单下的条目数量。"""
    init_db()
    conn = connect()
    try:
        return rows_to_dicts(conn.execute(
            "select d.id, d.key, d.label, d.sort_order, d.is_default, d.pinned, "
            "(select count(*) from counterparty_lists l where l.kind = d.key) as item_count "
            "from counterparty_list_defs d where coalesce(d.hidden, 0) = 0 "
            "order by d.sort_order, d.id"
        ).fetchall())
    finally:
        conn.close()


def _list_def_keys():
    try:
        conn = connect()
        try:
            return {row["key"] for row in conn.execute(
                "select key from counterparty_list_defs where coalesce(hidden, 0) = 0").fetchall()}
        finally:
            conn.close()
    except sqlite3.Error:
        return set()


def _clean_list_label(label):
    text = str(label or "").strip()
    if not text:
        raise ValueError("名单名不能为空")
    if len(text) > 30:
        raise ValueError("名单名最多 30 个字")
    return text


def add_list_def(label, copy_from=None):
    label = _clean_list_label(label)
    init_db()
    conn = connect()
    try:
        for row in conn.execute("select label from counterparty_list_defs where coalesce(hidden, 0) = 0").fetchall():
            if str(row["label"]).strip() == label:
                raise ValueError("名单名已存在")
        existing_keys = {row["key"] for row in conn.execute("select key from counterparty_list_defs").fetchall()}
        source_key = str(copy_from or "").strip()
        if source_key:
            if source_key not in existing_keys:
                raise ValueError("要复制的名单不存在")
            if not conn.execute(
                "select 1 from counterparty_list_defs where key = ? and coalesce(hidden, 0) = 0", (source_key,)
            ).fetchone():
                raise ValueError("要复制的名单已被删除")
        key = None
        for _ in range(50):
            candidate = "custom_" + uuid.uuid4().hex[:8]
            if candidate not in existing_keys:
                key = candidate
                break
        if not key:
            raise ValueError("名单 key 生成失败，请重试")
        max_order = conn.execute("select coalesce(max(sort_order), 0) from counterparty_list_defs").fetchone()[0]
        conn.execute(
            "insert into counterparty_list_defs"
            "(key, label, sort_order, is_default, hidden, pinned, created_at) "
            "values (?, ?, ?, 0, 0, 0, ?)",
            (key, label, int(max_order) + 10, now_iso()),
        )
        copied = 0
        if source_key:
            # 复制条目：target_type / object_name / entry_id 原样搬过来，只换所属名单 key
            rows = conn.execute(
                "select target_type, object_name, entry_id, label, note from counterparty_lists "
                "where kind = ? order by id",
                (source_key,),
            ).fetchall()
            ts = now_iso()
            for row in rows:
                conn.execute(
                    "insert into counterparty_lists(kind, target_type, object_name, entry_id, label, note, created_at) "
                    "values (?, ?, ?, ?, ?, ?, ?)",
                    (key, row["target_type"], row["object_name"], row["entry_id"], row["label"], row["note"], ts),
                )
                copied += 1
        conn.commit()
        return {"ok": True, "key": key, "label": label, "copied": copied, "copy_from": source_key or None}
    finally:
        conn.close()


def rename_list_def(key, label):
    key = str(key or "").strip()
    label = _clean_list_label(label)
    if not key:
        raise ValueError("key is required")
    init_db()
    conn = connect()
    try:
        if not conn.execute(
            "select 1 from counterparty_list_defs where key = ? and coalesce(hidden, 0) = 0", (key,)
        ).fetchone():
            raise ValueError("名单不存在")
        for row in conn.execute("select key, label from counterparty_list_defs where coalesce(hidden, 0) = 0").fetchall():
            if row["key"] != key and str(row["label"]).strip() == label:
                raise ValueError("名单名已存在")
        conn.execute("update counterparty_list_defs set label = ? where key = ?", (label, key))
        conn.commit()
        return {"ok": True, "key": key, "label": label}
    finally:
        conn.close()


def delete_list_def(key):
    """删除名单：级联删掉该 kind 下的条目，并用 hidden=1 留墓碑。

    留墓碑是为了让 ensure_default_list_defs 在下次启动时不会把默认名单重新补回来。
    """
    key = str(key or "").strip()
    if not key:
        raise ValueError("key is required")
    init_db()
    conn = connect()
    try:
        if not conn.execute(
            "select 1 from counterparty_list_defs where key = ? and coalesce(hidden, 0) = 0", (key,)
        ).fetchone():
            raise ValueError("名单不存在")
        removed = conn.execute("select count(*) from counterparty_lists where kind = ?", (key,)).fetchone()[0]
        conn.execute("delete from counterparty_lists where kind = ?", (key,))
        conn.execute("update counterparty_list_defs set hidden = 1 where key = ?", (key,))
        conn.commit()
        return {"ok": True, "key": key, "removed_items": int(removed)}
    finally:
        conn.close()


def pin_list_def(key, pinned=True):
    """置顶 / 取消置顶一个名单。

    置顶总数上限 LIST_PIN_LIMIT：到上限再置顶直接报错（不顶掉别人、不静默失败）。
    重复置顶或重复取消都是幂等的，不会产生脏数据。
    """
    key = str(key or "").strip()
    if not key:
        raise ValueError("key is required")
    target = 0 if str(pinned).strip().lower() in ("0", "false", "no", "off", "") else 1
    init_db()
    conn = connect()
    try:
        row = conn.execute(
            "select pinned from counterparty_list_defs where key = ? and coalesce(hidden, 0) = 0", (key,)
        ).fetchone()
        if not row:
            raise ValueError("名单不存在")
        current = int(row["pinned"] or 0)
        if target == 1 and current != 1:
            pinned_count = conn.execute(
                "select count(*) from counterparty_list_defs "
                "where coalesce(hidden, 0) = 0 and coalesce(pinned, 0) = 1"
            ).fetchone()[0]
            if int(pinned_count) >= LIST_PIN_LIMIT:
                raise ValueError(f"最多置顶 {LIST_PIN_LIMIT} 个")
            conn.execute("update counterparty_list_defs set pinned = 1 where key = ?", (key,))
            conn.commit()
        elif target == 0 and current != 0:
            conn.execute("update counterparty_list_defs set pinned = 0 where key = ?", (key,))
            conn.commit()
        return {"ok": True, "key": key, "pinned": target, "changed": int(target != current)}
    finally:
        conn.close()


def _normalize_list_kind(kind):
    kind = str(kind or "").strip()
    if not kind:
        raise ValueError("invalid list kind")
    keys = _list_def_keys()
    if not keys:
        keys = set(LIST_KINDS)
    if kind not in keys:
        raise ValueError("invalid list kind")
    return kind


def list_counterparty_items(kind=None):
    init_db()
    conn = connect()
    try:
        sql = (
            "select l.id, l.kind, l.target_type, l.object_name, l.entry_id, l.label, l.note, l.created_at, "
            "e.transaction_time, e.amount_cents, e.category, e.type, e.account "
            "from counterparty_lists l left join entries e on e.id = l.entry_id"
        )
        params = ()
        if kind:
            sql += " where l.kind = ?"
            params = (_normalize_list_kind(kind),)
        sql += " order by l.kind, l.created_at desc, l.id desc"
        return rows_to_dicts(conn.execute(sql, params).fetchall())
    finally:
        conn.close()


def add_counterparty_item(kind, target_type, object_name=None, entry_id=None, label=None, note=None):
    init_db()
    kind = _normalize_list_kind(kind)
    target_type = "entry" if str(target_type or "").strip() == "entry" else "object"
    object_name = str(object_name or "").strip() or None
    raw_entry_id = str(entry_id if entry_id is not None else "").strip()
    entry_id = int(raw_entry_id) if raw_entry_id.isdigit() and int(raw_entry_id) > 0 else None
    if target_type == "object" and not object_name:
        raise ValueError("object_name is required")
    if target_type == "entry" and not entry_id:
        raise ValueError("entry_id is required")
    conn = connect()
    try:
        if target_type == "object":
            existing = conn.execute(
                "select id from counterparty_lists where kind = ? and target_type = 'object' and object_name = ?",
                (kind, object_name),
            ).fetchone()
        else:
            existing = conn.execute(
                "select id from counterparty_lists where kind = ? and target_type = 'entry' and entry_id = ?",
                (kind, entry_id),
            ).fetchone()
        if existing:
            return {"ok": True, "id": existing["id"], "duplicated": True}
        cur = conn.execute(
            "insert into counterparty_lists(kind, target_type, object_name, entry_id, label, note, created_at) "
            "values (?, ?, ?, ?, ?, ?, ?)",
            (
                kind, target_type, object_name, entry_id,
                str(label or "").strip() or None, str(note or "").strip() or None, now_iso(),
            ),
        )
        conn.commit()
        return {"ok": True, "id": cur.lastrowid, "duplicated": False}
    finally:
        conn.close()


def update_counterparty_item(item_id, label=None, note=None):
    init_db()
    conn = connect()
    try:
        if not conn.execute("select id from counterparty_lists where id = ?", (int(item_id),)).fetchone():
            raise ValueError("item not found")
        conn.execute(
            "update counterparty_lists set label = ?, note = ? where id = ?",
            (str(label or "").strip() or None, str(note or "").strip() or None, int(item_id)),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def delete_counterparty_item(item_id):
    init_db()
    conn = connect()
    try:
        conn.execute("delete from counterparty_lists where id = ?", (int(item_id),))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def confirm_pending_entry(entry_id, category, tx_type=None, learn=False, transaction_object=None, note=None):
    conn = connect()
    try:
        row = conn.execute("select * from entries where id = ? and status = 'pending'", (entry_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    data = {
        "id": entry_id,
        "category": category,
    }
    if tx_type:
        data["type"] = tx_type
    if transaction_object is not None:
        data["transaction_object"] = str(transaction_object or "").strip()
    if note is not None:
        data["note"] = str(note or "").strip()
    update_entry(entry_id, data)
    conn = connect()
    try:
        conn.execute("update entries set status = 'confirmed' where id = ?", (entry_id,))
        if learn:
            keyword = data.get("transaction_object")
            if keyword is None:
                keyword = row["transaction_object"]
            if keyword:
                add_rule(conn, keyword, category, tx_type or row["type"])
        conn.commit()
    finally:
        conn.close()
    return {"status": "confirmed", "id": entry_id}


def confirm_entry(unconfirmed_id, category, tx_type=None, learn=False, transaction_object=None, note=None, source=None):
    init_db()
    if source != "unconfirmed":
        pending_result = confirm_pending_entry(unconfirmed_id, category, tx_type, learn, transaction_object, note)
        if pending_result:
            return pending_result
    if source == "pending":
        raise SystemExit(f"pending entry not found: {unconfirmed_id}")
    conn = connect()
    row = conn.execute("select * from unconfirmed_entries where id = ?", (unconfirmed_id,)).fetchone()
    if not row:
        raise SystemExit(f"unconfirmed entry not found: {unconfirmed_id}")
    record = dict(row)
    record["category"] = category
    if transaction_object is not None:
        record["transaction_object"] = str(transaction_object or "").strip()
    if note is not None:
        record["note"] = str(note or "").strip()
    if tx_type:
        record["type"] = tx_type
    record["amount"] = money(record.pop("amount_cents"))
    conn.execute("delete from unconfirmed_entries where id = ?", (unconfirmed_id,))
    conn.commit()
    conn.close()
    result = insert_entry(record, auto_learn=learn)
    rule_keyword = record.get("transaction_object") or row["transaction_object"]
    if learn and rule_keyword:
        conn = connect()
        add_rule(conn, rule_keyword, category, tx_type or row["type"])
        conn.commit()
        conn.close()
    return result


def revert_entry_to_pending(entry_id):
    """把一笔账目退回「待确认」并清空分类。用于误选撤销。"""
    entry_id = int(entry_id)
    init_db()
    conn = connect()
    try:
        row = conn.execute("select id, category, status from entries where id = ?", (entry_id,)).fetchone()
        if not row:
            raise ValueError("entry not found")
        previous = row["category"]
        conn.execute("update entries set category = null, status = 'pending' where id = ?", (entry_id,))
        conn.commit()
        return {"ok": True, "id": entry_id, "previous_category": previous}
    finally:
        conn.close()


def set_entry_category(entry_id, category, restore_status=None):
    """只改分类，不动金额/时间/账户等其它字段。

    改分类默认会把账目标记为已确认；撤销时传 restore_status='pending' 可把状态一起还原，
    这样「改分类 → 撤销」不会留下待确认数据的副作用。
    """
    entry_id = int(entry_id)
    status = str(restore_status or "").strip()
    is_restore = status in ("pending", "confirmed")
    category = str(category or "").strip()
    if not category and not is_restore:
        # 撤销是还原动作，允许把分类还原成原本的空值
        raise ValueError("category is required")
    init_db()
    conn = connect()
    try:
        row = conn.execute("select id, type from entries where id = ?", (entry_id,)).fetchone()
        if not row:
            raise ValueError("entry not found")
        if status in ("pending", "confirmed"):
            conn.execute(
                "update entries set category = ?, status = ? where id = ?",
                (category, status, entry_id),
            )
        else:
            conn.execute(
                "update entries set category = ?, status = 'confirmed' where id = ?",
                (category, entry_id),
            )
        conn.commit()
        return {"ok": True, "id": entry_id, "category": category}
    finally:
        conn.close()


def revert_entry_categories(items):
    """撤销分类改动：把一批账目的分类和状态写回旧值。

    items 形如 [{"id": 12, "category": "餐饮/饮料", "status": "pending"}, ...]。
    category 允许为空（原本就未分类）；status 只在是 pending / confirmed 时才写回，
    其余情况只还原分类，避免把状态改成意料之外的值。
    """
    cleaned = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        try:
            entry_id = int(raw.get("id"))
        except (TypeError, ValueError):
            continue
        status = str(raw.get("status") or "").strip()
        cleaned.append((entry_id, str(raw.get("category") or ""), status if status in ("pending", "confirmed") else None))
    if not cleaned:
        raise ValueError("items is required")
    init_db()
    conn = connect()
    try:
        ok_ids, failed = [], []
        for entry_id, category, status in cleaned:
            if not conn.execute("select id from entries where id = ?", (entry_id,)).fetchone():
                failed.append({"id": entry_id, "error": "not found"})
                continue
            if status:
                conn.execute(
                    "update entries set category = ?, status = ? where id = ?",
                    (category, status, entry_id),
                )
            else:
                conn.execute("update entries set category = ? where id = ?", (category, entry_id))
            ok_ids.append(entry_id)
        conn.commit()
        return {"ok": len(ok_ids), "failed": failed, "ids": ok_ids}
    finally:
        conn.close()


def batch_confirm(entry_ids, category, learn=False):
    """批量确认一批待确认账目到同一个分类。"""
    category = str(category or "").strip()
    if not category:
        raise ValueError("category is required")
    ids = []
    for raw in entry_ids or []:
        try:
            ids.append(int(raw))
        except (TypeError, ValueError):
            continue
    if not ids:
        raise ValueError("entry_ids is required")
    ok_ids, failed, objects, types = [], [], set(), set()
    for entry_id in ids:
        try:
            res = confirm_pending_entry(entry_id, category)
        except Exception as exc:
            failed.append({"id": entry_id, "error": str(exc)})
            continue
        if res:
            ok_ids.append(entry_id)
        else:
            failed.append({"id": entry_id, "error": "not pending"})
    if learn and ok_ids:
        init_db()
        conn = connect()
        try:
            holes = ",".join("?" for _ in ok_ids)
            for row in conn.execute(
                f"select distinct transaction_object, type from entries where id in ({holes})", tuple(ok_ids)
            ).fetchall():
                name = str(row["transaction_object"] or "").strip()
                if name:
                    objects.add(name)
                    types.add(row["type"])
            for name in objects:
                add_rule(conn, name, category, None)
            conn.commit()
        finally:
            conn.close()
    return {
        "ok": len(ok_ids),
        "failed": failed,
        "ids": ok_ids,
        "learned": sorted(objects),
    }


def update_entry(entry_id, data):
    init_db()
    conn = connect()
    try:
        old = conn.execute("select * from entries where id = ?", (entry_id,)).fetchone()
        if not old:
            raise ValueError(f"entry not found: {entry_id}")
        record = dict(old)
        editable_fields = [
            "transaction_time",
            "type",
            "category",
            "amount",
            "currency",
            "transaction_object",
            "account",
            "target_account",
            "participant",
            "balance_delta_cents",
            "actual_balance_cents",
            "note",
        ]
        for field in editable_fields:
            if field in data:
                record[field] = data[field]
        parsed_time = parse_transaction_time(record.get("transaction_time"))
        if not parsed_time:
            raise ValueError("invalid transaction_time")
        record["transaction_time"] = parsed_time
        record = normalize_record(conn, record, apply_rules=False)
        amount_cents = abs(cents(record.get("amount", money(old["amount_cents"]))))
        required_missing = not record.get("transaction_time") or not record.get("account") or not record.get("type") or not amount_cents
        if record.get("type") == "转账" and not record.get("target_account"):
            required_missing = True
        if record.get("type") == "转账" and record.get("target_account") and not is_internal_transfer_record(conn, record):
            required_missing = True
        if record.get("type") == "转账" and record.get("account") == record.get("target_account"):
            raise ValueError("transfer target_account must differ from account")
        needs_category = record.get("type") not in NON_REPORTING_TYPES and not record.get("category")
        if required_missing or needs_category:
            raise ValueError("transaction_time, type, category, amount, account and target_account for transfers are required")
        new_status = "confirmed" if old["status"] == "pending" and not needs_category else old["status"]

        update_account_balance(conn, old["account"], old["type"], -old["amount_cents"], old["balance_delta_cents"])
        if old["type"] == "转账" and old["target_account"]:
            update_account_balance(conn, old["target_account"], "收入", -old["amount_cents"])
        conn.execute(
            """
            update entries set transaction_time = ?, type = ?, category = ?, status = ?, amount_cents = ?, currency = ?,
                transaction_object = ?, account = ?, target_account = ?, participant = ?,
                balance_delta_cents = ?, actual_balance_cents = ?, note = ?
            where id = ?
            """,
            (
                record["transaction_time"],
                record["type"],
                record.get("category"),
                new_status,
                amount_cents,
                record["currency"],
                record.get("transaction_object"),
                record["account"],
                record.get("target_account"),
                record["participant"],
                record.get("balance_delta_cents"),
                record.get("actual_balance_cents"),
                record.get("note"),
                entry_id,
            ),
        )
        update_account_balance(conn, record["account"], record["type"], amount_cents, record.get("balance_delta_cents"))
        if record.get("type") == "转账":
            update_account_balance(conn, record["target_account"], "收入", amount_cents)
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def delete_entry(entry_id):
    init_db()
    conn = connect()
    try:
        entry = conn.execute("select * from entries where id = ?", (entry_id,)).fetchone()
        if not entry:
            raise ValueError(f"entry not found: {entry_id}")
        update_account_balance(conn, entry["account"], entry["type"], -entry["amount_cents"], entry["balance_delta_cents"])
        if entry["type"] == "转账" and entry["target_account"]:
            update_account_balance(conn, entry["target_account"], "收入", -entry["amount_cents"])
        conn.execute("delete from entries where id = ?", (entry_id,))
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def transfer(from_account, to_account, amount, note=None, transaction_time=None, currency="CNY"):
    amount_cents = cents(amount)
    if from_account == to_account:
        raise ValueError("transfer accounts must differ")
    init_db()
    conn = connect()
    try:
        ensure_account(conn, from_account, currency)
        ensure_account(conn, to_account, currency)
        ts = now_iso()
        tx_time = transaction_time or ts
        conn.execute(
            """
            insert into entries(transaction_time, type, category, amount_cents, currency, account,
                target_account, participant, note)
            values (?, '转账', '转账', ?, ?, ?, ?, '自己', ?)
            """,
            (tx_time, amount_cents, currency, from_account, to_account, note or "账户间转账"),
        )
        update_account_balance(conn, from_account, "转账", amount_cents)
        update_account_balance(conn, to_account, "收入", amount_cents)
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
    finally:
        conn.close()


def balance_correction_transaction_time(conn, account):
    row = conn.execute(
        """
        select transaction_time
        from entries
        where type != '余额修正'
            and (account = ? or target_account = ?)
        order by transaction_time desc, id desc
        limit 1
        """,
        (account, account),
    ).fetchone()
    latest = parse_transaction_time(row["transaction_time"]) if row else None
    if not latest:
        return now_iso()
    return (dt.datetime.fromisoformat(latest) + dt.timedelta(seconds=1)).isoformat(sep=" ")


def correct_balance(account, actual, note=None):
    init_db()
    conn = connect()
    try:
        ensure_account(conn, account)
        row = conn.execute("select current_balance_cents from accounts where name = ?", (account,)).fetchone()
        actual_cents = cents(actual)
        delta = actual_cents - row["current_balance_cents"]
        if delta == 0:
            return {"delta": 0, "entry_id": None}
        ts = balance_correction_transaction_time(conn, account)
        conn.execute(
            """
            insert into entries(transaction_time, type, category, amount_cents, currency, account, participant,
                balance_delta_cents, actual_balance_cents, note)
            values (?, '余额修正', '余额修正', ?, 'CNY', ?, '自己', ?, ?, ?)
            """,
            (
                ts,
                abs(delta),
                account,
                delta,
                actual_cents,
                note or "手动余额修正",
            ),
        )
        entry_id = conn.execute("select last_insert_rowid()").fetchone()[0]
        conn.execute(
            "update accounts set current_balance_cents = ?, updated_at = ? where name = ?",
            (actual_cents, now_iso(), account),
        )
        sync_current_balances_from_entries(conn)
        conn.commit()
        return {"delta": delta, "entry_id": entry_id, "transaction_time": ts}
    finally:
        conn.close()


def read_standard_csv(path):
    if Path(path).suffix.lower() != ".csv":
        raise SystemExit("import only accepts a cleaned standard CSV. Convert raw bills before importing.")
    data = Path(path).read_bytes()
    for enc in ["utf-8-sig", "gb18030", "utf-8"]:
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = data.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def parse_transaction_time(value):
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        number = float(text)
        if number > 25569:
            parsed = dt.datetime(1899, 12, 30) + dt.timedelta(days=number)
            return parsed.replace(microsecond=0).isoformat(sep=" ")
    normalized = text
    normalized = re.sub(r"[年月]", "-", normalized)
    normalized = normalized.replace("日", " ")
    normalized = normalized.replace("/", "-")
    normalized = normalized.replace("T", " ")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    normalized = re.sub(r"^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$", lambda m: f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}{m.group(4)}", normalized)
    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ]
    for fmt in formats:
        try:
            parsed = dt.datetime.strptime(normalized, fmt)
            return parsed.replace(microsecond=0).isoformat(sep=" ")
        except ValueError:
            pass
    try:
        parsed = dt.datetime.fromisoformat(normalized)
        return parsed.replace(microsecond=0).isoformat(sep=" ")
    except ValueError:
        return None


def normalize_import_record(record, row_number):
    normalized = {}
    for key, value in record.items():
        clean_key = str(key or "").strip()
        clean_value = value.strip() if isinstance(value, str) else value
        canonical_key = clean_key
        for target, aliases in IMPORT_FIELD_ALIASES.items():
            if clean_key in aliases:
                canonical_key = target
                break
        if canonical_key and (canonical_key not in normalized or normalized[canonical_key] in (None, "")):
            normalized[canonical_key] = clean_value
    parsed_time = parse_transaction_time(normalized.get("transaction_time"))
    if not parsed_time:
        columns = ", ".join(str(key).strip() for key in record.keys())
        raise SystemExit(f"row {row_number} missing or invalid transaction_time; columns: {columns}")
    normalized["transaction_time"] = parsed_time
    return normalized


def parse_category_path(value):
    text = str(value or "").strip()
    if not text:
        return None, None, None
    text = re.sub(r"\s+", "", text)
    parts = [part for part in re.split(r"[/／>＞|｜]", text) if part]
    if len(parts) >= 2:
        level1, level2 = parts[0], "/".join(parts[1:])
        return level1, level2, f"{level1}/{level2}"
    return parts[0], None, parts[0]


def import_file(path, default_account=None, duplicate_account_map=None):
    return import_file_with_options(path, default_account=default_account, duplicate_account_map=duplicate_account_map)


def imported_status_counts(entry_ids, unconfirmed_ids):
    counts = {"confirmed": 0, "pending": 0, "unconfirmed": 0}
    entry_ids = [int(entry_id) for entry_id in entry_ids]
    unconfirmed_ids = [int(entry_id) for entry_id in unconfirmed_ids]
    conn = connect()
    try:
        if entry_ids:
            rows = conn.execute(
                f"select status, count(*) c from entries where id in ({', '.join('?' for _ in entry_ids)}) group by status",
                tuple(entry_ids),
            ).fetchall()
            for row in rows:
                status = row["status"] or "confirmed"
                counts[status if status in {"confirmed", "pending"} else "confirmed"] += row["c"]
        if unconfirmed_ids:
            counts["unconfirmed"] = conn.execute(
                f"select count(*) c from unconfirmed_entries where id in ({', '.join('?' for _ in unconfirmed_ids)})",
                tuple(unconfirmed_ids),
            ).fetchone()["c"]
        return counts
    finally:
        conn.close()


def import_file_with_options(path, default_account=None, duplicate_account_map=None):
    rows = read_standard_csv(path)
    rows = [normalize_import_record(record, index) for index, record in enumerate(rows, start=2)]
    balance_correction_rows = [
        str(index)
        for index, record in enumerate(rows, start=2)
        if str(record.get("type") or "").strip() == "余额修正"
    ]
    if balance_correction_rows:
        preview = ", ".join(balance_correction_rows[:10])
        suffix = "..." if len(balance_correction_rows) > 10 else ""
        raise SystemExit(
            f"standard CSV import does not accept type=余额修正; use correct-balance instead. rows: {preview}{suffix}"
        )
    init_db()
    counts = {"confirmed": 0, "pending": 0, "unconfirmed": 0}
    preexisting_accounts = existing_account_names()
    imported_entry_ids = []
    imported_unconfirmed_ids = []
    conn = connect()
    try:
        for record in rows:
            if default_account and not record.get("account"):
                record["account"] = default_account
            result = insert_entry_with_conn(conn, record, raw_payload=record)
            counts[result["status"]] += 1
            if result["status"] in {"confirmed", "pending"}:
                imported_entry_ids.append(result["id"])
            elif result["status"] == "unconfirmed":
                imported_unconfirmed_ids.append(result["id"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    zero_amount_deleted = cleanup_imported_zero_amount_entries(
        imported_entry_ids,
        imported_unconfirmed_ids,
        preexisting_accounts=preexisting_accounts,
    )
    if zero_amount_deleted:
        counts["zero_amount_deleted"] = zero_amount_deleted
        counts["confirmed"] = max(0, counts["confirmed"] - zero_amount_deleted.get("confirmed", 0))
        counts["unconfirmed"] = max(0, counts["unconfirmed"] - zero_amount_deleted.get("unconfirmed", 0))
        imported_entry_ids = [entry_id for entry_id in imported_entry_ids if entry_id not in zero_amount_deleted.get("entry_ids", [])]
        imported_unconfirmed_ids = [
            entry_id for entry_id in imported_unconfirmed_ids
            if entry_id not in zero_amount_deleted.get("unconfirmed_ids", [])
        ]
    duplicate_account_map = normalize_duplicate_account_map(duplicate_account_map)
    confirmed_duplicates = dedupe_imported_entries_by_time(
        imported_entry_ids,
        preexisting_accounts=preexisting_accounts,
        account_alias_map=duplicate_account_map,
    )
    unconfirmed_duplicates = dedupe_imported_unconfirmed_by_time(
        imported_unconfirmed_ids,
        preexisting_accounts=preexisting_accounts,
        account_alias_map=duplicate_account_map,
    )
    duplicates = merge_duplicate_stats(confirmed_duplicates, unconfirmed_duplicates)
    counts.update(imported_status_counts(imported_entry_ids, imported_unconfirmed_ids))
    if duplicates:
        confirmed_deduped = duplicate_total(confirmed_duplicates)
        unconfirmed_deduped = duplicate_total(unconfirmed_duplicates)
        counts["deduped"] = confirmed_deduped + unconfirmed_deduped
        counts["duplicate_accounts"] = duplicate_account_counts(duplicates)
        counts["duplicate_account_pairs"] = duplicate_account_pairs(duplicates)
        counts["notices"] = duplicate_notices(duplicates)
    if zero_amount_deleted:
        counts.setdefault("notices", []).append(
            f"导入发现 0 金额记录【{zero_amount_deleted['total']}】条，已自动删除。"
        )
    dedupe_entries()
    conn = connect()
    try:
        sync_account_debts_from_entries(conn)
        sync_current_balances_from_entries(conn)
        conn.commit()
    finally:
        conn.close()
    return counts


def normalize_duplicate_account_map(value):
    if not value:
        return {}
    if isinstance(value, (str, Path)):
        path = Path(value)
        text = path.read_text(encoding="utf-8") if path.exists() else str(value)
        value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("duplicate account map must be a JSON object")
    return {
        str(source or "").strip(): str(target or "").strip()
        for source, target in value.items()
        if str(source or "").strip() and str(target or "").strip()
    }


def accounts_match_for_duplicate(imported_account, existing_account, account_alias_map=None):
    imported = str(imported_account or "").strip()
    existing = str(existing_account or "").strip()
    if not imported or not existing:
        return imported == existing
    if imported == existing:
        return True
    account_alias_map = account_alias_map or {}
    return account_alias_map.get(imported) == existing


def import_duplicate_analysis(path, default_account=None, tolerance_seconds=2):
    rows = read_standard_csv(path)
    normalized_rows = [normalize_import_record(record, index) for index, record in enumerate(rows, start=2)]
    conn = connect()
    try:
        candidates = []
        imported_accounts = collections.Counter()
        existing_accounts = collections.Counter(
            row["account"]
            for row in conn.execute("select account from entries where coalesce(account, '') != ''").fetchall()
        )
        for index, record in enumerate(normalized_rows, start=2):
            if default_account and not record.get("account"):
                record["account"] = default_account
            normalized = normalize_record(conn, record)
            account = str(normalized.get("account") or "").strip()
            imported_accounts[account or "未命名账户"] += 1
            imported_ts = entry_timestamp(normalized.get("transaction_time"))
            if imported_ts is None:
                continue
            amount_cents = abs(cents(normalized.get("amount")))
            window_start = dt.datetime.fromtimestamp(imported_ts - tolerance_seconds).isoformat(sep=" ")
            window_end = dt.datetime.fromtimestamp(imported_ts + tolerance_seconds).isoformat(sep=" ")
            matches = conn.execute(
                """
                select id, transaction_time, type, category, amount_cents, account, target_account,
                    transaction_object, note
                from entries
                where transaction_time between ? and ? and amount_cents = ?
                order by abs(strftime('%s', transaction_time) - ?), id
                """,
                (window_start, window_end, amount_cents, int(imported_ts)),
            ).fetchall()
            for match in matches:
                candidates.append({
                    "row_number": index,
                    "imported_time": normalized.get("transaction_time"),
                    "existing_id": match["id"],
                    "existing_time": match["transaction_time"],
                    "time_delta_seconds": abs(entry_timestamp(match["transaction_time"]) - imported_ts),
                    "amount": money(amount_cents),
                    "imported_account": account,
                    "existing_account": match["account"],
                    "imported_type": normalized.get("type"),
                    "existing_type": match["type"],
                    "imported_object": normalized.get("transaction_object"),
                    "existing_object": match["transaction_object"],
                    "imported_note": normalized.get("note"),
                    "existing_note": match["note"],
                })
    finally:
        conn.close()

    pair_counts = collections.Counter(
        (item["imported_account"] or "未命名账户", item["existing_account"] or "未命名账户")
        for item in candidates
    )
    return {
        "tolerance_seconds": tolerance_seconds,
        "imported_accounts": dict(imported_accounts),
        "existing_accounts": dict(existing_accounts),
        "overlapping_account_pairs": [
            {
                "imported_account": imported,
                "existing_account": existing,
                "candidate_count": count,
            }
            for (imported, existing), count in pair_counts.most_common()
        ],
        "candidates": candidates,
        "account_map_format": {"新导入账户名": "数据库已有账户名"},
        "guidance": "代码只列出完整交易时间相差不超过 2 秒且金额一致的候选。只把能确认同一资金账户的名称对写入 duplicate_account_map；不确定时不要写入。",
    }


def standard_csv_analysis(path, default_account=None):
    rows = read_standard_csv(path)
    normalized_rows = [normalize_import_record(record, index) for index, record in enumerate(rows, start=2)]
    init_db()
    conn = connect()
    try:
        stats = {
            "path": str(path),
            "total_rows": len(normalized_rows),
            "types": collections.Counter(),
            "accounts": collections.Counter(),
            "target_accounts": collections.Counter(),
            "categories": collections.Counter(),
            "missing": collections.Counter(),
            "invalid_amount_rows": [],
            "zero_amount_rows": [],
        }
        for index, record in enumerate(normalized_rows, start=2):
            if default_account and not record.get("account"):
                record["account"] = default_account
            try:
                normalized = normalize_record(conn, record)
                amount_cents = abs(cents(normalized.get("amount")))
            except Exception as exc:
                stats["invalid_amount_rows"].append({"row_number": index, "error": str(exc)})
                continue
            tx_type = normalized.get("type") or "未指定"
            account = str(normalized.get("account") or "").strip() or "未命名账户"
            target_account = str(normalized.get("target_account") or "").strip()
            category = str(normalized.get("category") or "").strip() or "未分类"
            stats["types"][tx_type] += 1
            stats["accounts"][account] += 1
            if target_account:
                stats["target_accounts"][target_account] += 1
            stats["categories"][category] += 1
            if not amount_cents:
                stats["zero_amount_rows"].append(index)
            if not normalized.get("type"):
                stats["missing"]["type"] += 1
            if not normalized.get("account"):
                stats["missing"]["account"] += 1
            if normalized.get("type") == "转账" and not normalized.get("target_account"):
                stats["missing"]["target_account_for_transfer"] += 1
            if normalized.get("type") == "转账" and normalized.get("target_account") and not is_internal_transfer_record(conn, normalized):
                stats["missing"]["known_internal_transfer_accounts"] += 1
            if normalized.get("type") not in {"转账", "余额修正"} and not normalized.get("category"):
                stats["missing"]["category"] += 1
        return {
            "path": stats["path"],
            "total_rows": stats["total_rows"],
            "types": dict(stats["types"].most_common()),
            "accounts": dict(stats["accounts"].most_common()),
            "target_accounts": dict(stats["target_accounts"].most_common()),
            "categories": dict(stats["categories"].most_common()),
            "missing": dict(stats["missing"].most_common()),
            "invalid_amount_rows": stats["invalid_amount_rows"][:50],
            "invalid_amount_count": len(stats["invalid_amount_rows"]),
            "zero_amount_rows": stats["zero_amount_rows"][:50],
            "zero_amount_count": len(stats["zero_amount_rows"]),
            "standard_import_fields": [
                "transaction_time",
                "type",
                "category_level1",
                "category_level2",
                "category",
                "amount",
                "currency",
                "transaction_object",
                "account",
                "target_account",
                "participant",
                "note",
            ],
        }
    finally:
        conn.close()


def normalize_keyword_rules(value):
    if not value:
        return []
    if isinstance(value, (str, Path)):
        path = Path(value)
        text = path.read_text(encoding="utf-8") if path.exists() else str(value)
        value = json.loads(text)
    if not isinstance(value, list):
        raise ValueError("keyword rules must be a JSON array")
    rules = []
    for index, rule in enumerate(value, start=1):
        if not isinstance(rule, dict):
            raise ValueError(f"keyword rule {index} must be an object")
        keyword = str(rule.get("keyword") or "").strip()
        category = standardize_category(rule.get("category"), rule.get("type"))
        tx_type = str(rule.get("type") or "").strip()
        if not keyword:
            raise ValueError(f"keyword rule {index} missing keyword")
        if tx_type and tx_type not in ENTRY_TYPES:
            raise ValueError(f"keyword rule {index} has invalid type")
        if not category:
            raise ValueError(f"keyword rule {index} has invalid category")
        rules.append({"keyword": keyword, "category": category, "type": tx_type})
    return rules


def db_keyword_rules(conn):
    return [
        {"keyword": row["merchant"], "category": row["category"], "type": row["type"] or ""}
        for row in conn.execute(
            "select merchant, category, type from merchant_category_rules order by length(merchant) desc"
        ).fetchall()
    ]


def standard_row_raw_category(record):
    return "/".join(
        part
        for part in [
            str(record.get("category_level1") or "").strip(),
            str(record.get("category_level2") or "").strip(),
        ]
        if part
    ) or str(record.get("category") or "").strip()


def keyword_candidate_analysis(path, default_account=None):
    rows = read_standard_csv(path)
    normalized_rows = [normalize_import_record(record, index) for index, record in enumerate(rows, start=2)]
    min_count = max(3, math.ceil(len(normalized_rows) * 0.02))
    init_db()
    conn = connect()
    try:
        object_counter = collections.Counter()
        note_counter = collections.Counter()
        raw_category_counter = collections.Counter()
        examples = {}
        unmatched_count = 0
        db_rule_applied = 0
        for index, record in enumerate(normalized_rows, start=2):
            if default_account and not record.get("account"):
                record["account"] = default_account
            without_rules = normalize_record(conn, record, apply_rules=False)
            normalized = normalize_record(conn, record, apply_rules=True)
            if not without_rules.get("category") and normalized.get("category"):
                db_rule_applied += 1
            if normalized.get("type") in {"转账", "余额修正"} or normalized.get("category"):
                continue
            unmatched_count += 1
            fields = {
                "transaction_object": str(normalized.get("transaction_object") or "").strip(),
                "note": str(normalized.get("note") or "").strip(),
                "raw_category": standard_row_raw_category(record),
                "type": str(normalized.get("type") or "").strip(),
                "account": str(normalized.get("account") or "").strip(),
                "amount": str(normalized.get("amount") or "").strip(),
                "transaction_time": str(normalized.get("transaction_time") or "").strip(),
            }
            for key, counter in [
                ("transaction_object", object_counter),
                ("note", note_counter),
                ("raw_category", raw_category_counter),
            ]:
                value = fields[key]
                if value:
                    counter[value] += 1
                    examples.setdefault(key, {}).setdefault(value, fields | {"row_number": index})

        def top(counter, key):
            return [
                {"value": value, "count": count, "example": examples.get(key, {}).get(value)}
                for value, count in counter.most_common()
                if count >= min_count
            ]

        return {
            "path": str(path),
            "total_rows": len(normalized_rows),
            "db_rule_applied": db_rule_applied,
            "unmatched_count": unmatched_count,
            "min_count": min_count,
            "min_count_formula": "max(3, ceil(total_rows * 0.02))",
            "candidates": {
                "transaction_object": top(object_counter, "transaction_object"),
                "note": top(note_counter, "note"),
                "raw_category": top(raw_category_counter, "raw_category"),
            },
            "rule_format": [
                {"keyword": "地铁", "category": "交通/公共交通", "type": "支出"}
            ],
            "guidance": (
                "Group candidates by type first. Only return high-confidence, reusable keyword rules. "
                "Use transaction_object directly only when it clearly represents a stable single category. "
                "Do not create unconditional rules for broad platform names such as 美团, 京东 or 淘宝; "
                "inspect note details for concrete brands or merchants instead. Prefer specific stable brand keywords, "
                "and do not use personal names, platform names, order ids, one-off full titles, or ambiguous words."
            ),
        }
    finally:
        conn.close()


def apply_keyword_rules_to_standard_csv(path, output, keyword_rules):
    rules = normalize_keyword_rules(keyword_rules)
    rows = read_standard_csv(path)
    if not rows:
        fieldnames = [
            "transaction_time",
            "type",
            "category_level1",
            "category_level2",
            "category",
            "amount",
            "currency",
            "transaction_object",
            "account",
            "target_account",
            "participant",
            "note",
        ]
    else:
        fieldnames = list(rows[0].keys())
    updated = 0
    matched_rules = collections.Counter()
    for row in rows:
        text = " ".join(str(row.get(field) or "") for field in ["transaction_object", "note"])
        if row.get("category"):
            continue
        for rule in rules:
            if rule["keyword"] not in text:
                continue
            row["category"] = rule["category"]
            if rule["type"]:
                row["type"] = rule["type"]
            updated += 1
            matched_rules[rule["keyword"]] += 1
            break
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return {
        "output": str(output_path),
        "rules": len(rules),
        "updated_rows": updated,
        "matched_rules": dict(matched_rules.most_common()),
    }


def unconfirmed_summary(limit=20):
    init_db()
    conn = connect()
    try:
        rows = conn.execute(
            """
            select id, transaction_time, type, category, amount_cents, account, target_account,
                transaction_object, note, null raw_payload
            from entries
            where status = 'pending'
            union all
            select id, transaction_time, type, category, amount_cents, account, target_account,
                transaction_object, note, raw_payload
            from unconfirmed_entries
            order by transaction_time desc, id desc
            """
        ).fetchall()
        reasons = collections.Counter()
        by_type = collections.Counter()
        by_account = collections.Counter()
        by_raw_category = collections.Counter()
        for row in rows:
            tx_type = row["type"] or "未指定"
            by_type[tx_type] += 1
            by_account[(row["account"] or "未命名账户")] += 1
            payload = parse_attributes(row["raw_payload"])
            raw_category = (
                "/".join(part for part in [payload.get("category_level1"), payload.get("category_level2")] if part)
                or payload.get("category")
                or "未指定"
            )
            by_raw_category[str(raw_category)] += 1
            if not row["type"]:
                reasons["missing_type"] += 1
            if not row["account"]:
                reasons["missing_account"] += 1
            if row["type"] == "转账" and not row["target_account"]:
                reasons["missing_target_account_for_transfer"] += 1
            if row["type"] == "转账" and row["target_account"] and not is_internal_transfer_record(conn, dict(row)):
                reasons["unknown_internal_transfer_accounts"] += 1
            if row["type"] not in {"转账", "余额修正"} and not row["category"]:
                reasons["missing_category"] += 1
        return {
            "total": len(rows),
            "reasons": dict(reasons.most_common()),
            "by_type": dict(by_type.most_common()),
            "by_account": dict(by_account.most_common(limit)),
            "by_raw_category": dict(by_raw_category.most_common(limit)),
        }
    finally:
        conn.close()


def existing_account_names():
    conn = connect()
    try:
        names = set(config_account_names())
        names.update(row["name"] for row in conn.execute("select name from accounts").fetchall())
        return names
    finally:
        conn.close()


def entry_timestamp(value):
    parsed = parse_transaction_time(value)
    if not parsed:
        return None
    return dt.datetime.fromisoformat(parsed).timestamp()


def new_duplicate_stats():
    return collections.defaultdict(collections.Counter)


def record_duplicate(stats, removed_account, kept_account):
    removed = str(removed_account or "").strip() or "未命名账户"
    kept = str(kept_account or "").strip() or "未命名账户"
    stats[removed][kept] += 1


def merge_duplicate_stats(*stats_items):
    merged = new_duplicate_stats()
    for stats in stats_items:
        for removed_account, kept_accounts in stats.items():
            merged[removed_account].update(kept_accounts)
    return {account: dict(kept_accounts) for account, kept_accounts in merged.items() if kept_accounts}


def duplicate_total(stats):
    return sum(sum(kept_accounts.values()) for kept_accounts in stats.values())


def duplicate_account_counts(stats):
    return {account: sum(kept_accounts.values()) for account, kept_accounts in stats.items()}


def duplicate_account_pairs(stats):
    return {account: dict(kept_accounts) for account, kept_accounts in stats.items()}


def duplicate_notices(stats):
    notices = []
    for removed_account, kept_accounts in stats.items():
        total = sum(kept_accounts.values())
        if len(kept_accounts) == 1:
            kept_account = next(iter(kept_accounts.keys()))
            notices.append(f"识别到来自【{removed_account}】重复交易【{total}】笔，已合并到【{kept_account}】并去重！")
            continue
        detail = "、".join(f"【{account}】{count}笔" for account, count in kept_accounts.items())
        notices.append(f"识别到来自【{removed_account}】重复交易【{total}】笔，已分别合并到{detail}并去重！")
    return notices


def rollback_entry_balance(conn, entry):
    update_account_balance(conn, entry["account"], entry["type"], -entry["amount_cents"], entry["balance_delta_cents"])
    if entry["type"] == "转账" and entry["target_account"]:
        update_account_balance(conn, entry["target_account"], "收入", -entry["amount_cents"])


def cleanup_unused_import_account(conn, account, preexisting_accounts):
    account = str(account or "").strip()
    if not account or account in preexisting_accounts:
        return
    row = conn.execute(
        "select initial_balance_cents, current_balance_cents from accounts where name = ?",
        (account,),
    ).fetchone()
    if not row or row["initial_balance_cents"] != 0 or row["current_balance_cents"] != 0:
        return
    usage = conn.execute(
        """
        select
            (select count(*) from entries where account = ? or target_account = ?) +
            (select count(*) from unconfirmed_entries where account = ? or target_account = ?) as c
        """,
        (account, account, account, account),
    ).fetchone()["c"]
    if usage == 0:
        conn.execute("delete from accounts where name = ?", (account,))


def cleanup_imported_zero_amount_entries(imported_entry_ids, imported_unconfirmed_ids, preexisting_accounts=None):
    preexisting_accounts = preexisting_accounts or set()
    entry_ids = [int(entry_id) for entry_id in imported_entry_ids]
    unconfirmed_ids = [int(entry_id) for entry_id in imported_unconfirmed_ids]
    removed_entry_ids = []
    removed_unconfirmed_ids = []
    conn = connect()
    try:
        if entry_ids:
            rows = conn.execute(
                f"select * from entries where id in ({', '.join('?' for _ in entry_ids)}) and amount_cents = 0",
                tuple(entry_ids),
            ).fetchall()
            for row in rows:
                rollback_entry_balance(conn, row)
                conn.execute("delete from entries where id = ?", (row["id"],))
                cleanup_unused_import_account(conn, row["account"], preexisting_accounts)
                cleanup_unused_import_account(conn, row["target_account"], preexisting_accounts)
                removed_entry_ids.append(row["id"])
        if unconfirmed_ids:
            rows = conn.execute(
                f"select * from unconfirmed_entries where id in ({', '.join('?' for _ in unconfirmed_ids)}) and amount_cents = 0",
                tuple(unconfirmed_ids),
            ).fetchall()
            for row in rows:
                conn.execute("delete from unconfirmed_entries where id = ?", (row["id"],))
                cleanup_unused_import_account(conn, row["account"], preexisting_accounts)
                cleanup_unused_import_account(conn, row["target_account"], preexisting_accounts)
                removed_unconfirmed_ids.append(row["id"])
        conn.commit()
    finally:
        conn.close()
    total = len(removed_entry_ids) + len(removed_unconfirmed_ids)
    if not total:
        return {}
    return {
        "confirmed": len(removed_entry_ids),
        "unconfirmed": len(removed_unconfirmed_ids),
        "total": total,
        "entry_ids": removed_entry_ids,
        "unconfirmed_ids": removed_unconfirmed_ids,
    }


def dedupe_imported_entries_by_time(imported_entry_ids, tolerance_seconds=2, preexisting_accounts=None, account_alias_map=None):
    if not imported_entry_ids:
        return {}
    preexisting_accounts = preexisting_accounts or set()
    imported_ids = {int(entry_id) for entry_id in imported_entry_ids}
    conn = connect()
    try:
        imported_rows = conn.execute(
            f"select * from entries where id in ({', '.join('?' for _ in imported_ids)}) order by id",
            tuple(imported_ids),
        ).fetchall()
        if not imported_rows:
            return {}
        timestamps = [entry_timestamp(row["transaction_time"]) for row in imported_rows]
        timestamps = [item for item in timestamps if item is not None]
        if not timestamps:
            return {}
        window_start = dt.datetime.fromtimestamp(min(timestamps) - tolerance_seconds).isoformat(sep=" ")
        window_end = dt.datetime.fromtimestamp(max(timestamps) + tolerance_seconds).isoformat(sep=" ")
        candidates = conn.execute(
            """
            select * from entries
            where transaction_time between ? and ?
            order by id
            """,
            (window_start, window_end),
        ).fetchall()
        candidate_data = [(row, entry_timestamp(row["transaction_time"])) for row in candidates]
        candidate_data = [(row, ts) for row, ts in candidate_data if ts is not None]
        duplicate_stats = new_duplicate_stats()
        removed_ids = set()
        for current in imported_rows:
            current_id = int(current["id"])
            if current_id in removed_ids:
                continue
            current_ts = entry_timestamp(current["transaction_time"])
            if current_ts is None:
                continue
            earlier = [
                row for row, ts in candidate_data
                if int(row["id"]) < current_id
                and int(row["id"]) not in imported_ids
                and int(row["id"]) not in removed_ids
                and abs(ts - current_ts) <= tolerance_seconds
                and row["amount_cents"] == current["amount_cents"]
                and accounts_match_for_duplicate(current["account"], row["account"], account_alias_map)
            ]
            if not earlier:
                continue
            kept = earlier[0]
            record_duplicate(duplicate_stats, current["account"], kept["account"])
            rollback_entry_balance(conn, current)
            conn.execute("delete from entries where id = ?", (current_id,))
            cleanup_unused_import_account(conn, current["account"], preexisting_accounts)
            cleanup_unused_import_account(conn, current["target_account"], preexisting_accounts)
            removed_ids.add(current_id)
        conn.commit()
        return merge_duplicate_stats(duplicate_stats)
    finally:
        conn.close()


def dedupe_imported_unconfirmed_by_time(imported_unconfirmed_ids, tolerance_seconds=2, preexisting_accounts=None, account_alias_map=None):
    if not imported_unconfirmed_ids:
        return {}
    preexisting_accounts = preexisting_accounts or set()
    imported_ids = {int(entry_id) for entry_id in imported_unconfirmed_ids}
    conn = connect()
    try:
        imported_rows = conn.execute(
            f"select * from unconfirmed_entries where id in ({', '.join('?' for _ in imported_ids)}) order by id",
            tuple(imported_ids),
        ).fetchall()
        if not imported_rows:
            return {}
        timestamps = [entry_timestamp(row["transaction_time"]) for row in imported_rows]
        timestamps = [item for item in timestamps if item is not None]
        if not timestamps:
            return {}
        window_start = dt.datetime.fromtimestamp(min(timestamps) - tolerance_seconds).isoformat(sep=" ")
        window_end = dt.datetime.fromtimestamp(max(timestamps) + tolerance_seconds).isoformat(sep=" ")
        candidates = conn.execute(
            """
            select * from entries
            where transaction_time between ? and ?
            order by id
            """,
            (window_start, window_end),
        ).fetchall()
        candidate_data = [(row, entry_timestamp(row["transaction_time"])) for row in candidates]
        candidate_data = [(row, ts) for row, ts in candidate_data if ts is not None]
        duplicate_stats = new_duplicate_stats()
        for current in imported_rows:
            current_ts = entry_timestamp(current["transaction_time"])
            if current_ts is None:
                continue
            earlier = [
                row for row, ts in candidate_data
                if abs(ts - current_ts) <= tolerance_seconds
                and row["amount_cents"] == current["amount_cents"]
                and accounts_match_for_duplicate(current["account"], row["account"], account_alias_map)
            ]
            if not earlier:
                continue
            kept = earlier[0]
            record_duplicate(duplicate_stats, current["account"], kept["account"])
            conn.execute("delete from unconfirmed_entries where id = ?", (current["id"],))
            cleanup_unused_import_account(conn, current["account"], preexisting_accounts)
            cleanup_unused_import_account(conn, current["target_account"], preexisting_accounts)
        conn.commit()
        return merge_duplicate_stats(duplicate_stats)
    finally:
        conn.close()


def dedupe_entries():
    conn = connect()
    rows = conn.execute(
        """
        select min(id) keep_id, group_concat(id) ids, count(*) c
        from entries
        group by transaction_time, type, amount_cents, account, coalesce(category, ''),
            coalesce(target_account, ''), coalesce(transaction_object, ''), coalesce(note, '')
        having c > 1
        """
    ).fetchall()
    removed = 0
    for row in rows:
        ids = [int(x) for x in row["ids"].split(",") if int(x) != row["keep_id"]]
        for entry_id in ids:
            entry = conn.execute("select account, target_account, type, amount_cents, balance_delta_cents from entries where id = ?", (entry_id,)).fetchone()
            if entry:
                rollback_entry_balance(conn, entry)
            conn.execute("delete from entries where id = ?", (entry_id,))
            removed += 1
    conn.commit()
    conn.close()
    return removed


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


def account_entry_delta_for(account, row):
    if row["type"] == "转账":
        if row["account"] == account:
            return -row["amount_cents"]
        if row["target_account"] == account:
            return row["amount_cents"]
        return 0
    if row["account"] != account:
        return 0
    return account_balance_delta(row["type"], row["amount_cents"], row["balance_delta_cents"]) or 0


def account_computed_balances(conn):
    accounts = rows_to_dicts(conn.execute("select * from accounts order by name").fetchall())
    results = []
    for account in accounts:
        name = account["name"]
        base_cents = account["initial_balance_cents"]
        base_time = account["created_at"]
        scan_after_time = "0001-01-01 00:00:00"
        base_id = 0
        base_type = "初始化"
        correction = conn.execute(
            """
            select id, transaction_time, actual_balance_cents
            from entries
            where type = '余额修正' and account = ? and actual_balance_cents is not null
            order by transaction_time desc, id desc limit 1
            """,
            (name,),
        ).fetchone()
        if correction:
            base_cents = correction["actual_balance_cents"]
            base_time = correction["transaction_time"]
            scan_after_time = correction["transaction_time"]
            base_id = correction["id"]
            base_type = "余额修正"
        rows = conn.execute(
            """
            select id, transaction_time, type, amount_cents, account, target_account, balance_delta_cents
            from entries
            where (account = ? or target_account = ?)
                and (transaction_time > ? or (transaction_time = ? and id > ?))
            order by transaction_time, id
            """,
            (name, name, scan_after_time, scan_after_time, base_id),
        ).fetchall()
        computed = base_cents + sum(account_entry_delta_for(name, row) for row in rows)
        result = dict(account)
        result["computed_balance_cents"] = computed
        result["balance_basis"] = base_type
        result["balance_basis_time"] = base_time
        result["balance_diff_cents"] = computed - account["current_balance_cents"]
        # 以下两个字段是**只读扩展**，不改上面任何计算逻辑：把已经算出来的重算基准
        # 与「基准之后的流水净额」暴露给前端，用于余额列显示「期初 + 流水」构成、
        # 以及「按当前实际余额倒推期初」。无余额修正时 net_flow_cents 就等于该账户
        # 账本全部流水的净额。
        result["balance_base_cents"] = base_cents
        result["net_flow_cents"] = computed - base_cents
        results.append(result)
    return results


def sync_current_balances_from_entries(conn):
    ts = now_iso()
    for account in account_computed_balances(conn):
        if account["computed_balance_cents"] == account["current_balance_cents"]:
            continue
        conn.execute(
            "update accounts set current_balance_cents = ?, updated_at = ? where name = ?",
            (account["computed_balance_cents"], ts, account["name"]),
        )


def api_summary():
    conn = connect()
    month = dt.datetime.now().strftime("%Y-%m")
    income = conn.execute(
        """
        select coalesce(sum(amount_cents),0) v from entries
        where type in ('收入','收款','借入') and coalesce(category,'') != '转账' and substr(transaction_time,1,7)=?
        """,
        (month,),
    ).fetchone()["v"]
    expense = conn.execute(
        """
        select coalesce(sum(amount_cents),0) v from entries
        where type in ('支出','还款','借出') and coalesce(category,'') != '转账' and substr(transaction_time,1,7)=?
        """,
        (month,),
    ).fetchone()["v"]
    accounts = rows_to_dicts(conn.execute("select * from accounts order by name").fetchall())
    account_balances = account_computed_balances(conn)
    categories = rows_to_dicts(
        conn.execute(
            """
            select coalesce(category, '未分类') category, sum(amount_cents) amount_cents
            from entries where type='支出' and coalesce(category,'') != '转账' and substr(transaction_time,1,7)=?
            group by category order by amount_cents desc limit 10
            """,
            (month,),
        ).fetchall()
    )
    trend = rows_to_dicts(
        conn.execute(
            """
            select substr(transaction_time,1,10) day,
                sum(case when type in ('收入','收款','借入') and coalesce(category,'') != '转账' then amount_cents else 0 end) income_cents,
                sum(case when type in ('支出','还款','借出') and coalesce(category,'') != '转账' then amount_cents else 0 end) expense_cents
            from entries where substr(transaction_time,1,7)=?
            group by day order by day
            """,
            (month,),
        ).fetchall()
    )
    unconfirmed = conn.execute(
        """
        select
            (select count(*) from entries where status = 'pending') +
            (select count(*) from unconfirmed_entries) c
        """
    ).fetchone()["c"]
    # 账本总条目数（首次使用引导用：为 0 就说明账本还是空的）。
    # 只读计数，不动任何数据；不认识这个字段的老前端不受影响。
    entries_count = conn.execute("select count(*) c from entries").fetchone()["c"]
    conn.close()
    return {
        "month": month,
        "income": money(income),
        "expense": money(expense),
        "balance": money(income - expense),
        "accounts": accounts,
        "account_balances": account_balances,
        "entries_count": entries_count,
        "categories": categories,
        "trend": trend,
        "unconfirmed_count": unconfirmed,
    }


# ════════════════════════════════════════════════════════════════════════════
# 数据质量扫描器（只读）
# 硬约束：全程只发 SELECT，不 INSERT / UPDATE / DELETE；不联网、不 import 任何
# 网络库、不调用任何模型接口——纯本地 SQLite 查询 + Python 计算，token 成本为 0。
# ════════════════════════════════════════════════════════════════════════════
QUALITY_RULES = {
    "transfer_as_income": ("内部划转被当收入", "high"),
    "duplicate": ("疑似重复", "medium"),
    "orphan_category": ("孤儿分类", "medium"),
    "outlier_amount": ("异常大额", "low"),
}
QUALITY_RULE_ORDER = ("transfer_as_income", "duplicate", "orphan_category", "outlier_amount")
QUALITY_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
INTERNAL_TRANSFER_KEYWORDS = (
    "转账", "转帐", "本人", "划转", "内部", "存入", "取出", "提现", "充值", "还款", "信用卡",
    "卡对卡", "余额宝", "零钱通", "理财通", "零钱",
)
# 微信 / 银行账单的固定文案。关键词落在这些片段里时只是说明性文字，不构成内部划转的
# 直接证据：仍然按规则命中（不丢结果），但标记 confidence=low，避免炫宾夺主。
QUALITY_BOILERPLATE_FRAGMENTS = (
    "状态:已转账", "状态：已转账", "状态:已存入零钱", "状态：已存入零钱",
    "微信交易类型:转账", "微信交易类型：转账", "转账备注:微信转账", "转账备注：微信转账",
    "中国银行信用卡",
)
# ── R2「疑似重复」的时间窗（秒） ─────────────────────────────────────────────
# 旧判据是「时间差 ≤ 1 天」，实测 69 条命中里绝大多数是正常多次小额消费
# （同一家店一天里买 4 次 2.5 元、同一条公交线一天坐 2 次 2 元），噪声太大。
# 收紧到 10 分钟后，留下的基本是「同一笔被记了两遍」。
DUPLICATE_WINDOW_SECONDS = 600             # 主判据：时间差 ≤ 10 分钟
DUPLICATE_FALLBACK_WINDOW_SECONDS = 86400  # 低可信兜底：时间差 ≤ 1 天
# 兜底判据（备注完全一致且 ≤1 天）默认关闭：账单固定文案（如「微信交易类型:转账」）
# 会让两个完全无关的对象也命中，实测从 14 条涨到 34 条、误报明显增多。
# 需要时把它改成 True 即可启用，命中结果会自动标注为低可信并排在后面。
DUPLICATE_LOW_CONFIDENCE_FALLBACK = False


def quality_median(values):
    ordered = sorted(values)
    size = len(ordered)
    if not size:
        return 0
    middle = size // 2
    if size % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def quality_time(row):
    parsed = parse_transaction_time(row.get("transaction_time"))
    if not parsed:
        return None
    try:
        return dt.datetime.fromisoformat(parsed)
    except ValueError:
        return None


def quality_gap_text(seconds):
    """把两个时间差的秒数写成好读的说法：12 秒 / 8 分 36 秒 / 3 小时 5 分。"""
    seconds = int(round(abs(seconds or 0)))
    if seconds < 60:
        return f"{seconds} 秒"
    if seconds < 3600:
        minutes, rest = divmod(seconds, 60)
        return f"{minutes} 分 {rest} 秒" if rest else f"{minutes} 分钟"
    hours, rest = divmod(seconds, 3600)
    minutes = rest // 60
    return f"{hours} 小时 {minutes} 分" if minutes else f"{hours} 小时"


def quality_keyword_hits(row):
    """在交易对象 / 备注里找内部划转关键词，并标出是否只是账单固定文案。"""
    hits = []
    for field, field_label in (("transaction_object", "交易对象"), ("note", "备注")):
        text = str(row.get(field) or "")
        if not text:
            continue
        lowered = text.lower()
        for keyword in INTERNAL_TRANSFER_KEYWORDS:
            start = lowered.find(keyword.lower())
            if start < 0:
                continue
            end = start + len(keyword)
            fragment = ""
            for candidate in QUALITY_BOILERPLATE_FRAGMENTS:
                frag_start = lowered.find(candidate.lower())
                if 0 <= frag_start and frag_start <= start and end <= frag_start + len(candidate):
                    fragment = candidate
                    break
            hits.append(
                {
                    "keyword": keyword,
                    "field": field_label,
                    "fragment": fragment,
                    "snippet": text[max(0, start - 8):end + 8],
                }
            )
    return hits


def scan_data_quality():
    """扫描账目数据质量问题。只读：仅 SELECT，返回 JSON 可序列化的结果字典。"""
    conn = connect()
    try:
        # order by transaction_time, id 与前端 rebuildEntryNumbers() 的排序规则一致
        rows = [dict(row) for row in conn.execute("select * from entries order by transaction_time, id").fetchall()]
        own_accounts = known_own_account_names(conn)
        # 标过「已判断」的 (规则, 账目) 组合：这些不再出现在扫描结果里
        dismissed_pairs = {
            (str(row["rule"]), int(row["entry_id"]))
            for row in conn.execute("select rule, entry_id from quality_dismissals").fetchall()
        }
    finally:
        conn.close()

    # 账本编号：最老 = 1，越新越大，同一时间按 id 升序（与前端编号完全一致）
    entry_numbers = {int(row["id"]): index + 1 for index, row in enumerate(rows)}
    valid_categories_set = valid_categories()
    items = []
    dismissed_hits = 0

    def add_item(rule, row, reason, suggestion, **extra):
        nonlocal dismissed_hits
        if (rule, int(row["id"])) in dismissed_pairs:
            dismissed_hits += 1
            return
        rule_label, severity = QUALITY_RULES[rule]
        item = {
            "rule": rule,
            "rule_label": rule_label,
            "severity": severity,
            "entry_id": int(row["id"]),
            "entry_no": entry_numbers.get(int(row["id"])),
            "transaction_time": row.get("transaction_time"),
            "type": row.get("type"),
            "status": row.get("status"),
            "amount_cents": int(row.get("amount_cents") or 0),
            "category": row.get("category"),
            "account": row.get("account"),
            "transaction_object": row.get("transaction_object"),
            "note": row.get("note"),
            "reason": reason,
            "suggestion": suggestion,
        }
        item.update(extra)
        items.append(item)

    income_expense_rows = [row for row in rows if row.get("type") in ("收入", "支出")]

    # ── R1 · 内部划转被当收支 ────────────────────────────────────────────────
    # b) 配对检测：金额相等（≤1 分）、时间差 ≤2 天、一进一出，且两个账户都是自有账户
    pair_partners = collections.defaultdict(list)
    timed_rows = [(row, quality_time(row)) for row in income_expense_rows]
    for index, (row_a, time_a) in enumerate(timed_rows):
        account_a = str(row_a.get("account") or "").strip()
        amount_a = abs(int(row_a.get("amount_cents") or 0))
        if not time_a or not amount_a or account_a not in own_accounts:
            continue
        for row_b, time_b in timed_rows[index + 1:]:
            if row_a.get("type") == row_b.get("type"):
                continue
            if str(row_b.get("account") or "").strip() not in own_accounts:
                continue
            if abs(abs(int(row_b.get("amount_cents") or 0)) - amount_a) > 1:
                continue
            if not time_b or abs((time_a - time_b).total_seconds()) > 2 * 86400:
                continue
            pair_partners[int(row_a["id"])].append(int(row_b["id"]))
            pair_partners[int(row_b["id"])].append(int(row_a["id"]))

    for row in income_expense_rows:
        hits = quality_keyword_hits(row)
        partners = sorted(pair_partners.get(int(row["id"]), []))
        if not hits and not partners:
            continue
        reasons = []
        confidence = "high"
        for hit in hits:
            if hit["fragment"]:
                confidence = "low"
                reasons.append(
                    f'{hit["field"]}命中关键词「{hit["keyword"]}」（出现在账单固定文案「{hit["fragment"]}」中，可信度较低）'
                )
            else:
                reasons.append(f'{hit["field"]}命中关键词「{hit["keyword"]}」，疑似自己账户间划转')
        if partners:
            confidence = "high"
            partner_text = "、".join(f"编号 {entry_numbers.get(partner)}" for partner in partners)
            reasons.append(f"与 {partner_text} 金额相同、一进一出、时间相差不超过 2 天，疑似同一次内部划转的两条记录")
            suggestion = (
                f"和 {partner_text} 一起核对原始流水：若确是本人账户间划转，把两条都改成 type=转账"
                "（转账只计余额、不进收支统计）；若只是两笔金额巧合的真实收支，忽略本条即可"
            )
        else:
            suggestion = (
                "核对原始流水：若这笔钱是自己在自己的账户之间搬（微信零钱↔银行卡、卡还信用卡等），"
                "改成 type=转账 即可从收支统计中排除；若是他人真实转入转出，忽略本条"
            )
        add_item(
            "transfer_as_income",
            row,
            "；".join(reasons),
            suggestion,
            confidence=confidence,
            pair_entry_nos=[entry_numbers.get(partner) for partner in partners],
        )

    # ── R2 · 疑似重复 ───────────────────────────────────────────────────────
    # 判据：金额 + 类型相同、时间差 ≤ 10 分钟、且「交易对象 / 备注 / 账户」至少一项相同。
    # 时间窗在 2026-11 从「≤ 1 天」收紧到「≤ 10 分钟」（见 DUPLICATE_* 常量），
    # 目的是滤掉「同一家店一天内正常消费好几笔」这类误报。
    duplicate_partners = collections.defaultdict(list)
    for index, row_a in enumerate(rows):
        amount_a = int(row_a.get("amount_cents") or 0)
        type_a = str(row_a.get("type") or "")
        for row_b in rows[index + 1:]:
            if int(row_b.get("amount_cents") or 0) != amount_a:
                continue
            if str(row_b.get("type") or "") != type_a:
                continue
            shared = []
            if row_a.get("transaction_object") and row_a.get("transaction_object") == row_b.get("transaction_object"):
                shared.append("交易对象")
            if row_a.get("note") and row_a.get("note") == row_b.get("note"):
                shared.append("备注")
            if row_a.get("account") and row_a.get("account") == row_b.get("account"):
                shared.append("账户")
            if not shared:
                continue
            time_a, time_b = quality_time(row_a), quality_time(row_b)
            if not time_a or not time_b:
                continue
            gap = abs((time_a - time_b).total_seconds())
            if gap <= DUPLICATE_WINDOW_SECONDS:
                confidence = "medium"
            elif (
                DUPLICATE_LOW_CONFIDENCE_FALLBACK
                and "备注" in shared
                and gap <= DUPLICATE_FALLBACK_WINDOW_SECONDS
            ):
                confidence = "low"
            else:
                continue
            duplicate_partners[int(row_a["id"])].append((int(row_b["id"]), shared, gap, confidence))
            duplicate_partners[int(row_b["id"])].append((int(row_a["id"]), shared, gap, confidence))

    for row in rows:
        partners = duplicate_partners.get(int(row["id"]), [])
        if not partners:
            continue
        strong = sorted((item for item in partners if item[3] != "low"), key=lambda item: item[0])
        weak = sorted((item for item in partners if item[3] == "low"), key=lambda item: item[0])

        def _partner_text(group):
            return "、".join(f"编号 {entry_numbers.get(pid)}" for pid, _, _, _ in group)

        def _nearest_gap(group):
            return min(gap for _, _, gap, _ in group)

        reasons = []
        if strong:
            strong_text = _partner_text(strong)
            shared_all = sorted({name for _, shared, _, _ in strong for name in shared})
            reasons.append(
                f"与 {strong_text} 的金额、类型完全相同，时间只差 {quality_gap_text(_nearest_gap(strong))}"
                f"（不超过 10 分钟），且{'、'.join(shared_all)}相同，疑似重复导入或重复记账"
            )
        if weak:
            weak_text = _partner_text(weak)
            reasons.append(
                f"低可信：与 {weak_text} 的金额、类型完全相同、备注也完全一致，"
                f"但时间相差 {quality_gap_text(_nearest_gap(weak))}（超过 10 分钟、在 1 天以内）"
                f"——账单固定文案常让不相关的两笔也命中，请优先核对上面时间更近的那条"
            )
        suggest_text = _partner_text(strong) if strong else _partner_text(weak)
        add_item(
            "duplicate",
            row,
            "；".join(reasons),
            f"翻出 {suggest_text} 对应的原始流水核对：确实是同一笔就删掉多余的那条（建议留信息更全的一条），"
            "不是重复的话在备注里写清区别，避免下次再被判为重复",
            confidence="low" if (weak and not strong) else "medium",
            nearest_gap_seconds=int(_nearest_gap(strong or weak)),
        )

    # ── R3 · 孤儿分类（分类缺失 / 非法） ────────────────────────────────────
    for row in rows:
        category = str(row.get("category") or "").strip()
        if category:
            if category in valid_categories_set:
                continue
            add_item(
                "orphan_category",
                row,
                f'分类「{category}」不在 config.yaml 的合法分类集合里（可能已被删除或改名）',
                "在「设置 → 分类」里把该分类补回，或在「待确认/编辑」里改成一个当前存在的分类；"
                "补回分类后这笔的历史统计才能重新归位",
            )
        else:
            # 转账 / 余额修正 / 期初资金这类「非收支」账目本来就不需要分类，
            # 所以「分类为空 + 已确认」对它们是正常状态，不能判成孤儿分类。
            if str(row.get("type") or "").strip() in NON_REPORTING_TYPES:
                continue
            if str(row.get("status") or "") != "confirmed":
                continue
            add_item(
                "orphan_category",
                row,
                "分类为空但账目已确认，统计时会被算进「未分类」，无法进入分类报表",
                "在「账单」里编辑这笔或按对象批量补一个合法分类；已确认状态不影响改分类",
            )

    # ── R4 · 异常大额（按大分类做中位数 + MAD 稳健离群） ────────────────────
    groups = collections.defaultdict(list)
    for row in rows:
        category = str(row.get("category") or "").strip()
        if not category:
            continue
        groups[category.split("/")[0]].append(row)
    for major, group in groups.items():
        if len(group) < 5:
            continue
        amounts = [abs(int(row.get("amount_cents") or 0)) for row in group]
        median = quality_median(amounts)
        mad = quality_median([abs(value - median) for value in amounts])
        threshold = median * 5 if mad == 0 else median + 10 * mad
        for row in group:
            amount = abs(int(row.get("amount_cents") or 0))
            if amount <= threshold or amount <= 50000:
                continue
            add_item(
                "outlier_amount",
                row,
                f"「{major}」下该分类共 {len(group)} 笔，金额中位数 {money(int(round(median)))} 元、"
                f"本笔 {money(amount)} 元、离群阈值 {money(int(round(threshold)))} 元"
                f"（{'中位数×5，因该组 MAD=0' if mad == 0 else '中位数+10×MAD'}）",
                "先核对金额是否多打了一个 0 之类的录入错误；确认无误就是一笔真实大额，无需处理，"
                "本条只作提示，不会影响统计口径",
                median_cents=int(round(median)),
                threshold_cents=int(round(threshold)),
            )

    items.sort(
        key=lambda item: (
            QUALITY_SEVERITY_ORDER.get(item["severity"], 9),
            QUALITY_RULE_ORDER.index(item["rule"]),
            1 if item.get("confidence") == "low" else 0,
            item["entry_no"] or 0,
        )
    )
    summary = {rule: sum(1 for item in items if item["rule"] == rule) for rule in QUALITY_RULE_ORDER}
    return {
        "generated_at": now_iso(),
        "entry_count": len(rows),
        "summary": summary,
        "items": items,
        # 被「已判断」挡掉、这次没有报出来的条数；不影响 items 本身
        "dismissed": dismissed_hits,
        "dismissed_total": len(dismissed_pairs),
    }


def _clean_quality_pairs(items):
    """把 [{rule, entry_id}, ...] 洗成合法的 (rule, entry_id) 列表，丢掉的都不合法。"""
    cleaned = []
    seen = set()
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        rule = str(raw.get("rule") or "").strip()
        if rule not in QUALITY_RULES:
            continue
        try:
            entry_id = int(raw.get("entry_id"))
        except (TypeError, ValueError):
            continue
        key = (rule, entry_id)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(key)
    return cleaned


def dismiss_quality_issues(items, note=""):
    """把若干「(规则, 账目)」标为已判断：以后扫描直接跳过，不再报出来。

    粒度是 (规则, 账目)：同一条账目可能同时命中「内部划转」和「异常大额」，
    忽略前者不影响后者——这两件事确实是两回事。
    """
    pairs = _clean_quality_pairs(items)
    if not pairs:
        raise ValueError("items is required")
    init_db()
    conn = connect()
    try:
        existing = {
            int(row[0])
            for row in conn.execute(
                "select id from entries where id in (%s)" % ",".join("?" for _ in pairs),
                tuple(entry_id for _, entry_id in pairs),
            ).fetchall()
        }
        ts = now_iso()
        note_text = str(note or "").strip()
        todo = [(rule, entry_id, note_text, ts) for rule, entry_id in pairs if entry_id in existing]
        if todo:
            conn.executemany(
                "insert into quality_dismissals(rule, entry_id, note, created_at) values (?, ?, ?, ?) "
                "on conflict(rule, entry_id) do update set note = excluded.note",
                todo,
            )
            conn.commit()
        return {
            "ok": len(todo),
            "missing": len(pairs) - len(todo),
            "items": [{"rule": rule, "entry_id": entry_id} for rule, entry_id, _, _ in todo],
        }
    finally:
        conn.close()


def undismiss_quality_issues(items):
    """取消「已判断」：这些条目下次扫描会重新报出来。"""
    pairs = _clean_quality_pairs(items)
    if not pairs:
        raise ValueError("items is required")
    init_db()
    conn = connect()
    try:
        removed = 0
        for rule, entry_id in pairs:
            cur = conn.execute(
                "delete from quality_dismissals where rule = ? and entry_id = ?",
                (rule, entry_id),
            )
            removed += cur.rowcount or 0
        conn.commit()
        return {"ok": removed}
    finally:
        conn.close()


def list_quality_dismissals():
    """已判断清单：给「已判断的条目」面板用，能看也能恢复。"""
    init_db()
    conn = connect()
    try:
        rows = conn.execute(
            """
            select d.id, d.rule, d.entry_id, d.note, d.created_at,
                   e.transaction_time, e.type, e.amount_cents, e.category,
                   e.transaction_object, e.account
            from quality_dismissals d
            left join entries e on e.id = d.entry_id
            order by d.created_at desc, d.id desc
            """
        ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            label = QUALITY_RULES.get(item["rule"])
            item["rule_label"] = label[0] if label else item["rule"]
            out.append(item)
        return out
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        size = int(self.headers.get("content-length", "0"))
        if not size:
            return {}
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def send_file(self, path, content_type=None):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        init_db()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.send_file(INDEX_PATH, "text/html; charset=utf-8")
            return
        if parsed.path.startswith("/static/"):
            rel = urllib.parse.unquote(parsed.path.removeprefix("/static/"))
            target = (STATIC_PATH / rel).resolve()
            if STATIC_PATH.resolve() not in target.parents or not target.is_file():
                self.send_json({"error": "not found"}, 404)
                return
            self.send_file(target)
            return
        conn = connect()
        try:
            if parsed.path == "/api/summary":
                self.send_json(api_summary())
            elif parsed.path == "/api/entries":
                rows = conn.execute("select * from entries order by transaction_time desc, id desc limit 200").fetchall()
                self.send_json(rows_to_dicts(rows))
            elif parsed.path == "/api/entries-all":
                rows = conn.execute("select * from entries order by transaction_time desc, id desc").fetchall()
                self.send_json(rows_to_dicts(rows))
            elif parsed.path == "/api/accounts":
                self.send_json(rows_to_dicts(conn.execute("select * from accounts order by name").fetchall()))
            elif parsed.path == "/api/account-debts":
                self.send_json(list_account_debts(conn))
            elif parsed.path == "/api/account-names":
                self.send_json(account_names())
            elif parsed.path == "/api/account-filter-names":
                self.send_json(historical_account_names())
            elif parsed.path == "/api/unconfirmed":
                if auto_apply_rules_enabled():
                    apply_all_keyword_rules_to_unconfirmed()
                self.send_json(rows_to_dicts(conn.execute(
                    """
                    select 'pending' source, id, transaction_time, type, category, status, amount_cents, currency, transaction_object,
                        account, target_account, participant, balance_delta_cents, actual_balance_cents, note,
                        null raw_payload
                    from entries
                    where status = 'pending'
                    union all
                    select 'unconfirmed' source, id, transaction_time, type, category, status, amount_cents, currency, transaction_object,
                        account, target_account, participant, balance_delta_cents, actual_balance_cents, note,
                        raw_payload
                    from unconfirmed_entries
                    order by transaction_time desc, id desc
                    """
                ).fetchall()))
            elif parsed.path == "/api/categories":
                self.send_json(flatten_categories())
            elif parsed.path == "/api/category-tree":
                self.send_json(category_tree())
            elif parsed.path == "/api/keyword-rules":
                self.send_json(list_keyword_rules())
            elif parsed.path == "/api/quality-scan":
                # 只读：scan_data_quality 内部只发 SELECT，不写库、不联网、不调模型；每次现算，不缓存
                self.send_json(scan_data_quality())
            elif parsed.path == "/api/quality-dismissals":
                self.send_json(list_quality_dismissals())
            elif parsed.path == "/api/initial-fund-candidates":
                # 只读：扫出该账户近期「流入方向 + 单笔 ≥ 阈值」的账目，供用户决定是否改判为
                # 「期初资金」（本金注入）。纯 SELECT，不写库、绝不自动改任何账目。
                query = urllib.parse.parse_qs(parsed.query)
                raw_min = (query.get("min_amount") or ["500"])[0]
                try:
                    min_amount_cents = int(round(float(str(raw_min).replace(",", "")) * 100))
                except (TypeError, ValueError):
                    min_amount_cents = 50000
                # do_GET 没有统一的异常处理，这里自己兜住，参数错误也要回 400 JSON
                # 而不是让连接被直接掐断（浏览器只会看到 network error）
                try:
                    self.send_json(
                        initial_fund_candidates(
                            (query.get("account") or [""])[0],
                            (query.get("days") or ["10"])[0],
                            min_amount_cents,
                            (query.get("end") or [None])[0],
                        )
                    )
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
            elif parsed.path == "/api/initial-fund-locate":
                # 账户页每行「定位期初」按钮专用：默认**全部历史 + 单笔 ≥ 100 元**，
                # 面板里可改 min_amount / days（days=0 = 全部历史、30/90/365 = 近 N 天）。
                # 与上面 /api/initial-fund-candidates 共用同一个只读函数，只是默认值不同：
                # 那条老路径（近 10 天 / 500 元）的默认值一个字都没动，行为照旧。
                # 纯 SELECT：不写库、不自动改任何账目。
                query = urllib.parse.parse_qs(parsed.query)
                raw_min = (query.get("min_amount") or ["100"])[0]
                try:
                    min_amount_cents = int(round(float(str(raw_min).replace(",", "").replace("，", "")) * 100))
                except (TypeError, ValueError):
                    min_amount_cents = 10000  # 非法阈值（空/abc/-）回退到默认 100 元，不报错
                if min_amount_cents < 0:
                    min_amount_cents = 10000
                raw_days = (query.get("days") or ["0"])[0]
                try:
                    days = int(str(raw_days).strip())
                except (TypeError, ValueError):
                    days = 0  # 非法时间范围 → 回退到「全部历史」
                try:
                    self.send_json(
                        initial_fund_candidates(
                            (query.get("account") or [""])[0],
                            days,
                            min_amount_cents,
                            (query.get("end") or [None])[0],
                        )
                    )
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
            elif parsed.path == "/api/settings":
                self.send_json(settings_snapshot())
            elif parsed.path == "/api/counterparty-lists":
                self.send_json(list_counterparty_items())
            elif parsed.path == "/api/list-defs":
                self.send_json(list_defs_with_counts())
            elif parsed.path == "/api/export.csv":
                rows = conn.execute("select * from entries order by transaction_time desc").fetchall()
                out = io.StringIO()
                writer = csv.writer(out)
                headers = rows[0].keys() if rows else ["id", "transaction_time", "type", "category", "amount"]
                writer.writerow(headers)
                for row in rows:
                    writer.writerow([row[h] for h in headers])
                data = out.getvalue().encode("utf-8-sig")
                self.send_response(200)
                self.send_header("content-type", "text/csv; charset=utf-8")
                self.send_header("content-disposition", "attachment; filename=bookkeeping.csv")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_json({"error": "not found"}, 404)
        finally:
            conn.close()

    def do_POST(self):
        init_db()
        parsed = urllib.parse.urlparse(self.path)
        try:
            data = self.read_json()
            if parsed.path == "/api/add":
                self.send_json(insert_entry(data, auto_learn=bool(data.get("learn"))))
            elif parsed.path == "/api/entry-update":
                self.send_json(update_entry(int(data["id"]), data))
            elif parsed.path == "/api/entry-delete":
                self.send_json(delete_entry(int(data["id"])))
            elif parsed.path == "/api/entry-revert":
                self.send_json(revert_entry_to_pending(int(data["id"])))
            elif parsed.path == "/api/entry-category":
                self.send_json(set_entry_category(
                    int(data["id"]), data.get("category"), data.get("restore_status"),
                ))
            elif parsed.path == "/api/batch-confirm":
                self.send_json(batch_confirm(data.get("ids") or [], data.get("category"), bool(data.get("learn"))))
            elif parsed.path == "/api/quality-dismiss":
                self.send_json(dismiss_quality_issues(data.get("items") or [], data.get("note")))
            elif parsed.path == "/api/quality-undismiss":
                self.send_json(undismiss_quality_issues(data.get("items") or []))
            elif parsed.path == "/api/category-revert":
                self.send_json(revert_entry_categories(data.get("items") or []))
            elif parsed.path == "/api/confirm":
                self.send_json(confirm_entry(
                    int(data["id"]),
                    data["category"],
                    data.get("type"),
                    bool(data.get("learn")),
                    data.get("transaction_object"),
                    data.get("note"),
                    data.get("source"),
                ))
            elif parsed.path == "/api/account-set":
                set_account(data["name"], data["balance"], data.get("currency", "CNY"), data.get("note"))
                self.send_json({"ok": True})
            elif parsed.path == "/api/account-initial-balance":
                # 只改期初余额（不碰余额语义），并立即重算写回 current_balance_cents
                self.send_json(set_initial_balance(data["name"], data["amount"], data.get("note")))
            elif parsed.path == "/api/account-add":
                add_account_name(data["name"])
                self.send_json({"ok": True})
            elif parsed.path == "/api/account-rename":
                self.send_json(rename_account_name(data["old_name"], data["new_name"]))
            elif parsed.path == "/api/account-delete":
                self.send_json(delete_account_name(data["name"]))
            elif parsed.path == "/api/account-debt-delete":
                self.send_json(hide_account_debt(int(data["id"])))
            elif parsed.path == "/api/category-add":
                add_category(data["type"], data["category"])
                self.send_json({"ok": True})
            elif parsed.path == "/api/category-rename":
                self.send_json(rename_category(data["type"], data["old_category"], data["new_category"]))
            elif parsed.path == "/api/category-delete":
                self.send_json(delete_category(data["type"], data["category"]))
            elif parsed.path == "/api/keyword-rule-add":
                self.send_json(add_keyword_rule_and_apply(data["keyword"], data["category"], data.get("type") or None))
            elif parsed.path == "/api/keyword-rule-delete":
                self.send_json(delete_keyword_rule(int(data["id"])))
            elif parsed.path == "/api/settings":
                self.send_json(set_setting(data.get("key"), data.get("value")))
            elif parsed.path == "/api/counterparty-list-add":
                self.send_json(add_counterparty_item(
                    data.get("kind"), data.get("target_type"), data.get("object_name"),
                    data.get("entry_id"), data.get("label"), data.get("note"),
                ))
            elif parsed.path == "/api/counterparty-list-update":
                self.send_json(update_counterparty_item(int(data["id"]), data.get("label"), data.get("note")))
            elif parsed.path == "/api/counterparty-list-delete":
                self.send_json(delete_counterparty_item(int(data["id"])))
            elif parsed.path == "/api/list-def-add":
                self.send_json(add_list_def(data.get("label"), data.get("copy_from")))
            elif parsed.path == "/api/list-def-rename":
                self.send_json(rename_list_def(data.get("key"), data.get("label")))
            elif parsed.path == "/api/list-def-delete":
                self.send_json(delete_list_def(data.get("key")))
            elif parsed.path == "/api/list-def-pin":
                self.send_json(pin_list_def(data.get("key"), data.get("pinned")))
            elif parsed.path == "/api/correct-balance":
                self.send_json(correct_balance(data["account"], data["actual"], data.get("note")))
            elif parsed.path == "/api/initial-fund-mark":
                # 只在用户勾选并二次确认后才会被调用；绝不自动改判
                self.send_json(mark_entries_as_initial_fund(data.get("ids") or []))
            elif parsed.path == "/api/import-preview":
                # 只读预览：扫描账单目录 → 解析 → 去重 → 与账本判重，不写任何东西
                self.send_json(import_preview(data))
            elif parsed.path == "/api/import-execute":
                # 默认 preview_only=true；只有显式传 false 才真写库（写前自动备份）
                self.send_json(import_execute(data))
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 400)


def print_table(rows, fields):
    if not rows:
        print("(none)")
        return
    widths = {f: max(len(f), *(len(str(row.get(f, ""))) for row in rows)) for f in fields}
    print("  ".join(f.ljust(widths[f]) for f in fields))
    print("  ".join("-" * widths[f] for f in fields))
    for row in rows:
        print("  ".join(str(row.get(f, "")).ljust(widths[f]) for f in fields))


def command_list(args):
    init_db()
    conn = connect()
    where = []
    params = []
    if args.month:
        where.append("substr(transaction_time,1,7)=?")
        params.append(args.month)
    if args.type:
        where.append("type=?")
        params.append(args.type)
    if args.category:
        where.append("category like ?")
        params.append(f"%{args.category}%")
    sql = "select id, transaction_time, type, category, status, amount_cents, account, target_account, transaction_object, note from entries"
    if where:
        sql += " where " + " and ".join(where)
    sql += " order by transaction_time desc, id desc limit ?"
    params.append(args.limit)
    rows = []
    for row in conn.execute(sql, params).fetchall():
        d = dict(row)
        d["amount"] = money(d.pop("amount_cents"))
        rows.append(d)
    print_table(rows, ["id", "transaction_time", "type", "category", "status", "amount", "account", "target_account", "transaction_object", "note"])
    conn.close()


def command_summary(args):
    init_db()
    month = args.month or dt.datetime.now().strftime("%Y-%m")
    conn = connect()
    rows = conn.execute(
        """
        select type, coalesce(category,'未分类') category, sum(amount_cents) amount_cents
        from entries
        where substr(transaction_time,1,7)=? and type not in ('转账','余额修正','期初资金') and coalesce(category,'') != '转账'
        group by type, category
        order by type, amount_cents desc
        """,
        (month,),
    ).fetchall()
    print(f"Month: {month}")
    for row in rows:
        print(f"{row['type']}\t{row['category']}\t{money(row['amount_cents'])}")
    conn.close()


def command_accounts(_args):
    init_db()
    conn = connect()
    rows = []
    for row in conn.execute("select name, initial_balance_cents, current_balance_cents, currency, updated_at from accounts order by name"):
        d = dict(row)
        d["initial_balance"] = money(d.pop("initial_balance_cents"))
        d["current_balance"] = money(d.pop("current_balance_cents"))
        rows.append(d)
    print_table(rows, ["name", "initial_balance", "current_balance", "currency", "updated_at"])
    conn.close()


def command_unconfirmed(_args):
    init_db()
    conn = connect()
    rows = []
    for row in conn.execute(
        """
        select 'pending' source, id, transaction_time, type, category, status, amount_cents, account, target_account, transaction_object, note
        from entries
        where status = 'pending'
        union all
        select 'unconfirmed' source, id, transaction_time, type, category, status, amount_cents, account, target_account, transaction_object, note
        from unconfirmed_entries
        order by transaction_time desc, id desc
        """
    ):
        d = dict(row)
        d["amount"] = money(d.pop("amount_cents"))
        rows.append(d)
    print_table(rows, ["source", "id", "transaction_time", "type", "category", "status", "amount", "account", "target_account", "transaction_object", "note"])
    conn.close()


def command_unconfirmed_summary(args):
    print(json.dumps(unconfirmed_summary(args.limit), ensure_ascii=False, indent=2))


def command_export(args):
    init_db()
    conn = connect()
    rows = conn.execute("select * from entries order by transaction_time desc").fetchall()
    target = open(args.output, "w", newline="", encoding="utf-8-sig") if args.output else sys.stdout
    with target:
        writer = csv.writer(target)
        if rows:
            writer.writerow(rows[0].keys())
            for row in rows:
                writer.writerow([row[k] for k in row.keys()])
    conn.close()


def build_parser():
    parser = argparse.ArgumentParser(description="Local-first SQLite bookkeeping skill")
    parser.add_argument("--db", dest="db_path", help="SQLite database path. Defaults to BOOKKEEPING_DB_PATH or ~/.local/share/bookkeeping/bookkeeping.db")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init-db")
    p.add_argument("--db-path", dest="init_db_path", help="Initialize and use this SQLite database path")

    sub.add_parser("db-path")

    p = sub.add_parser("add")
    p.add_argument("--type", required=True, choices=sorted(ENTRY_TYPES))
    p.add_argument("--amount", required=True)
    p.add_argument("--account", required=True)
    p.add_argument("--target-account", dest="target_account")
    p.add_argument("--category")
    p.add_argument("--transaction-object", dest="transaction_object")
    p.add_argument("--merchant", dest="transaction_object")
    p.add_argument("--counterparty", dest="transaction_object")
    p.add_argument("--participant", default="自己")
    p.add_argument("--note")
    p.add_argument("--currency", default="CNY")
    p.add_argument("--time", dest="transaction_time")
    p.add_argument("--learn", action="store_true")

    p = sub.add_parser("transfer")
    p.add_argument("--from-account", required=True)
    p.add_argument("--to-account", required=True)
    p.add_argument("--amount", required=True)
    p.add_argument("--note")
    p.add_argument("--time", dest="transaction_time")

    p = sub.add_parser("account-set")
    p.add_argument("name")
    p.add_argument("--balance", required=True)
    p.add_argument("--currency", default="CNY")
    p.add_argument("--note")

    p = sub.add_parser("correct-balance")
    p.add_argument("account")
    p.add_argument("--actual", required=True)
    p.add_argument("--note")

    p = sub.add_parser("set-initial-balance")
    p.add_argument("--account", required=True)
    p.add_argument("--amount", required=True)
    p.add_argument("--note")

    # 便捷入口：记一条「期初资金」（本金注入）。计入账户余额、不计入收入统计、不需要分类。
    # 与 set-initial-balance 的区别：那个只写 accounts.initial_balance_cents（不产生账目），
    # 这个会真正生成一条 entries 记录（用于「记账期间发生的大额注入」）。
    p = sub.add_parser("add-initial-fund", help="记一条期初资金（本金注入）：计入余额、不计入收入")
    p.add_argument("--account", required=True)
    p.add_argument("--amount", required=True)
    p.add_argument("--time", dest="transaction_time", help="交易时间，如 2026-10-08 12:00:00；缺省为现在")
    p.add_argument("--transaction-object", dest="transaction_object", help="交易对象（谁汇入的）")
    p.add_argument("--note")

    p = sub.add_parser("import")
    p.add_argument("path")
    p.add_argument("--account")
    p.add_argument("--duplicate-account-map", help="JSON object/file mapping imported account names to existing account names for cross-source duplicate removal")

    p = sub.add_parser("import-check")
    p.add_argument("path")
    p.add_argument("--account")
    p.add_argument("--output", help="Write standard CSV analysis JSON")

    p = sub.add_parser("keyword-candidates")
    p.add_argument("path")
    p.add_argument("--account")
    p.add_argument("--output", help="Write keyword candidate analysis JSON")

    p = sub.add_parser("apply-keyword-rules")
    p.add_argument("path")
    p.add_argument("--keyword-rules", required=True, help="JSON array/file of {keyword, category, type} rules")
    p.add_argument("--output", required=True)

    p = sub.add_parser("import-duplicates")
    p.add_argument("path")
    p.add_argument("--account")
    p.add_argument("--output", help="Write duplicate candidate analysis JSON for review")

    p = sub.add_parser("confirm")
    p.add_argument("id", type=int)
    p.add_argument("--category", required=True)
    p.add_argument("--type", choices=sorted(ENTRY_TYPES))
    p.add_argument("--note")
    p.add_argument("--learn", action="store_true")

    p = sub.add_parser("rule-add")
    p.add_argument("merchant")
    p.add_argument("--category", required=True)
    p.add_argument("--type", choices=sorted(ENTRY_TYPES))

    sub.add_parser("rule-list")

    p = sub.add_parser("rule-delete")
    p.add_argument("id", type=int)

    p = sub.add_parser("list")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--month")
    p.add_argument("--type")
    p.add_argument("--category")

    p = sub.add_parser("summary")
    p.add_argument("--month")

    sub.add_parser("accounts")
    sub.add_parser("unconfirmed")

    # 只读数据质量扫描：输出 JSON，方便命令行排查（不写库、不联网）
    sub.add_parser("quality-scan")

    p = sub.add_parser("unconfirmed-summary")
    p.add_argument("--limit", type=int, default=20)

    p = sub.add_parser("export")
    p.add_argument("--output")

    p = sub.add_parser("dashboard")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    set_database_path(getattr(args, "init_db_path", None) or getattr(args, "db_path", None))
    if args.cmd == "init-db":
        init_db()
        print(f"initialized {DB_PATH}")
    elif args.cmd == "db-path":
        print(DB_PATH)
    elif args.cmd == "add":
        result = insert_entry(vars(args), auto_learn=args.learn)
        print(json.dumps(result, ensure_ascii=False))
    elif args.cmd == "transfer":
        transfer(args.from_account, args.to_account, args.amount, args.note, args.transaction_time)
        print("ok")
    elif args.cmd == "account-set":
        set_account(args.name, args.balance, args.currency, args.note)
        print("ok")
    elif args.cmd == "correct-balance":
        print(json.dumps(correct_balance(args.account, args.actual, args.note), ensure_ascii=False))
    elif args.cmd == "set-initial-balance":
        print(json.dumps(set_initial_balance(args.account, args.amount, args.note), ensure_ascii=False))
    elif args.cmd == "add-initial-fund":
        result = insert_entry(
            {
                "type": "期初资金",
                "amount": args.amount,
                "account": args.account,
                "transaction_time": args.transaction_time,
                "transaction_object": args.transaction_object,
                "note": args.note,
                "participant": "自己",
                "currency": "CNY",
            }
        )
        print(json.dumps(result, ensure_ascii=False))
    elif args.cmd == "import":
        result = import_file_with_options(args.path, args.account, args.duplicate_account_map)
        for notice in result.get("notices", []):
            print(notice)
        print(json.dumps(result, ensure_ascii=False))
    elif args.cmd == "import-check":
        result = standard_csv_analysis(args.path, args.account)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"标准 CSV 检查: {output}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.cmd == "keyword-candidates":
        result = keyword_candidate_analysis(args.path, args.account)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"关键词候选分析: {output}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.cmd == "apply-keyword-rules":
        result = apply_keyword_rules_to_standard_csv(args.path, args.output, args.keyword_rules)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.cmd == "import-duplicates":
        result = import_duplicate_analysis(args.path, args.account)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"重复候选分析: {output}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.cmd == "confirm":
        print(json.dumps(confirm_entry(args.id, args.category, args.type, args.learn, note=args.note), ensure_ascii=False))
    elif args.cmd == "rule-add":
        result = add_keyword_rule_and_apply(args.merchant, args.category, args.type)
        print(json.dumps(result, ensure_ascii=False))
    elif args.cmd == "rule-list":
        print_table(list_keyword_rules(), ["id", "type", "category", "keyword"])
    elif args.cmd == "rule-delete":
        print(json.dumps(delete_keyword_rule(args.id), ensure_ascii=False))
    elif args.cmd == "list":
        command_list(args)
    elif args.cmd == "summary":
        command_summary(args)
    elif args.cmd == "accounts":
        command_accounts(args)
    elif args.cmd == "unconfirmed":
        command_unconfirmed(args)
    elif args.cmd == "unconfirmed-summary":
        command_unconfirmed_summary(args)
    elif args.cmd == "export":
        command_export(args)
    elif args.cmd == "quality-scan":
        # 只读扫描：不调用 init_db()，不触发任何表结构迁移或写库
        print(json.dumps(scan_data_quality(), ensure_ascii=False, indent=2))
    elif args.cmd == "dashboard":
        init_db()
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        print(f"Dashboard: http://{args.host}:{args.port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
