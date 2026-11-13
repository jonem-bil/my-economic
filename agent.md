# agent.md —— 给 AI 助手的说明

> 这份文件写给接手本仓库的 AI 助手。人类用户请看 [`README.md`](README.md)。
> 目标：让你不用读完所有源码，就能搞清楚结构、约定和坑。

---

## 1. 仓库有两个版本，别搞混

```
my-economic/
├── scripts/  static/  serve.cmd ...   ← 开发版（当前在用的代码）
└── 程序/                               ← 发布版（免安装，自带 Python）
    ├── 开始使用.cmd
    ├── python/          便携版 Python 3.12 + openpyxl（约 22MB）
    └── scripts/         开发版代码的副本
```

| | 用途 | 怎么跑 |
|---|---|---|
| **根目录** | 开发、调试、给 DSH skill 用 | 需要本机装 Python |
| **`程序/`** | 发给别人、换电脑、免安装 | 双击 `程序/开始使用.cmd`，**不需要装 Python** |

**⚠️ 两边代码是副本关系。** 改了根目录的 `scripts/`，必须同步到 `程序/scripts/`，否则两边会漂。
同步检查：

```powershell
foreach($f in @("bookkeeping.py","bill_import.py","bookkeeping_app\static\index.html","bookkeeping_app\static\dashboard.js","bookkeeping_app\static\dashboard.css")){
  (Get-FileHash "scripts\$f").Hash -eq (Get-FileHash "程序\scripts\$f").Hash
}
```

---

## 2. 技术栈

- **后端**：Python 3.12，**只用标准库**（`sqlite3` / `http.server` / `csv` / `json` / `argparse`）
- **唯一第三方依赖**：`openpyxl`（解析微信 XLSX），已随包放在 `程序/python/Lib/site-packages/`
- **前端**：原生 JavaScript 单页应用，无框架、无构建步骤
- **数据**：单个 SQLite 文件
- **不联网、无账号、无云同步**

---

## 3. 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `BOOKKEEPING_DB_PATH` | 数据库路径 | `~/.local/share/bookkeeping/bookkeeping.db` |
| `BOOKKEEPING_CONFIG_PATH` | 分类树配置 | `scripts/config.yaml` |
| `BOOKKEEPING_BACKUP_DIR` | 备份目录 | `<程序目录>/backup` |
| `BILL_IMPORT_DIR` | 账单扫描目录 | `<程序目录>/账单导入` |
| `BILL_ACC_WX_MAIN` / `_SUB` | 微信大号 / 小号账户名 | `微信大号` / `微信小号` |
| `BILL_ACC_ALIPAY` | 支付宝账户名 | `支付宝` |
| `BILL_ACC_PSBC` / `_CMB` | 邮储 / 招行账户名 | `邮储卡` / `招商银行` |
| `BILL_ACC_RELATIVE` | 亲属卡账户名 | `亲属卡` |
| `BILL_PSBC_CARD_TAIL` / `BILL_CMB_CARD_TAIL` | 账单里银行卡尾号（付款方式映射用） | `尾号` |
| `BILL_ALIPAY_OWNER_B_MARK` | 第二个支付宝账号在文件名里的标记 | `B` |

**账户名与卡号尾号必须走环境变量**（写进 `local-paths.cmd`）。代码里只留通用默认名：
硬编码真实昵称 / 卡号会导致 ① 隐私泄漏；② 别人用这套程序时账户名串成原作者的。

**🔴 最大的坑**：不设 `BOOKKEEPING_DB_PATH` 时程序会去找 `C:\Users\<用户>\.local\share\bookkeeping\bookkeeping.db`——那可能是另一个**空库**，表现为"数据全空"。
改任何启动脚本时必须带上这个环境变量。

---

## 4. 数据模型

### entries（账目，核心）
```
id, transaction_time, type, category, status, amount_cents, currency,
transaction_object, account, target_account, participant,
balance_delta_cents, actual_balance_cents, note,
overlap_flag, source_uid
```

### accounts（账户）
```
id, name, initial_balance_cents, current_balance_cents,
currency, note, created_at, updated_at
```

### 其他表
- `unconfirmed_entries` —— 金额 0 或字段不全的脏数据
- `counterparty_lists` —— 名单条目（`kind` + `target_type` + `object_name`/`entry_id`）
- `counterparty_list_defs` —— 名单定义（`key`/`label`/`sort_order`/`is_default`/`hidden`/`pinned`）
- `merchant_rules` —— 关键词规则（对象 → 分类）
- `app_settings` —— 设置（`auto_apply_rules` 等）

---

## 5. 关键语义（改代码前必须懂）

### type 九种取值

| 类别 | 类型 | 计余额 | 计收支统计 | 需要分类 |
|---|---|---|---|---|
| 收支 | 支出 / 收入 / 借入 / 借出 / 还款 / 收款 | ✅ | ✅ | ✅ |
| **非收支** | **转账 / 余额修正 / 期初资金** | ✅ | ❌ | ❌（免确认） |

- 收方向：`收入`、`收款`、`借入`、`期初资金`
- 支方向：`支出`、`还款`、`借出`

### 两套统计写法（最容易翻车）

```python
# ✅ 白名单式：新类型天然被排除
type in ('收入','收款','借入')

# ❌ 反白名单式：新类型会混进去！
type not in ('转账','余额修正')

# ❌ 前端反向判断：非收入即支出
isIncomeRow(row) ? 收入 : 支出
```

新增任何 type 时，**必须全局搜一遍 `not in` 和 `isIncomeRow` 这类反向判断**。
历史上「期初资金」就是漏了 `command_summary` + 前端三处，导致余额对不上。

### 账户余额算法
```
有「余额修正」记录 → 余额 = 最新修正值 + 该修正之后的流水
否则            → 余额 = 期初余额 + 全部流水净额
```
函数：`account_computed_balances()` / `sync_current_balances_from_entries()`。
**这段算法经过多轮对账验证，不要改。**

---

## 6. 铁律（违反会破坏用户数据）

1. **零删除** —— 账目只能改类型或加属性，**绝不删除**。用户原话："判断可以变，条目不能没。"
2. **不编造数据** —— 对不上账就报差异和原因，禁止补假账凑数字。
3. **改数据前先备份** —— 带时间戳目录，保留原文件。
4. **schema 变更必须幂等** —— `PRAGMA table_info` 判断后再 `ALTER`。
5. **`migrate_table` 会按 `ENTRY_COLUMNS` 重建表** —— 加列必须同时改三处：`ENTRY_COLUMNS`、`create_entries_table`、`migrate_table` 默认值。漏一处，下次启动列就被冲掉。
6. **本机路径只写 `local-paths.cmd`**（已 gitignore），不硬编码进被提交的文件。
7. **个人数据不进仓库** —— `.db` / 真实 `config.yaml` / `data/` / `backup/` 一律排除。

---

## 7. 导入机制

### 标准格式
```
transaction_time,type,category_level1,category_level2,category,
amount,currency,transaction_object,account,target_account,participant,note
```

### 三条关键规则

**① `source_uid` 是幂等键**
- 微信 → `WX-<交易单号>`
- 支付宝 → `AL-<交易订单号>`
- 银行 → `H-001` / `P-001`（按 `[时间, 金额, 对方, 原始行号]` 排序编号，**规则写死保证可重现**）
- 冲突组（同时间同金额同摘要）用 `H-S01` 这类特殊编码

**② 按支付方式判定归属，一笔只生成一次**
- 支付方式 = `零钱`/`余额` → 记平台账户
- 支付方式 = 自有银行卡 → 记银行账户（平台侧不生成）
- 这样从源头消除"同一笔钱记两次"

**③ PDF 有文本层，不要用 OCR**
- `page.get_text("words")` 拿坐标 → 按 y 聚类成行 → 按 x 排序拼接
- 直接 `get_text()` 得到的是单字竖排
- 邮储 PDF 的时间被劈成两行（日期 + 时分秒），要合并

---

## 8. 主要接口

```
GET  /api/summary                  总览
GET  /api/entries-all              全部账目
GET  /api/unconfirmed              待确认
GET  /api/categories               分类树
GET  /api/accounts                 账户与余额
GET  /api/counterparty-lists       名单条目
GET  /api/list-defs                名单定义
GET  /api/keyword-rules            关键词规则
GET  /api/quality-scan             质量扫描（只读，零 token）
GET  /api/initial-fund-candidates  期初候选（近期）
GET  /api/initial-fund-locate      期初候选（全部历史）
POST /api/import-preview           导入预览（只读）
POST /api/import-execute           导入执行（默认 dry-run）
POST /api/entry-update             改账目
POST /api/entry-category           改分类
POST /api/confirm | /api/batch-confirm
POST /api/account-initial-balance  设期初余额
POST /api/correct-balance          余额修正
POST /api/initial-fund-mark        标记期初资金
POST /api/list-def-add|rename|delete|pin
```

---

## 9. 前端结构（`dashboard.js` 约 4500 行）

| 区域 | 关键函数 |
|---|---|
| 视图切换 | `switchView()` |
| 总览 | `updateOverview()` / `aggregateRange()` / `drawTrend()` / `drawPie()` |
| 条目统计 | `renderEntries()` / `entryMatchesFilters()` / `amountHeaderCell()` |
| 按分类查找 | `renderCategoryBrowser()` |
| 交互消费统计 | `renderCounterpartyTable()` / `renderCounterpartyDetail()` / `cpScopedEntries()` |
| 待确认 | `renderPending()` / `renderPendingBatch()` |
| 质量审核 | `renderQualityPanel()` / `runQualityScan()` |
| 账户 | `renderAccountBalances()` / `renderLocateInitialPanel()` |
| 设置 | `renderCategoryHub()` / `renderSpecialLists()` / `renderImportPanel()` |

**已知技术债**：筛选状态是碎片化的（`entryFilters` / `cpFilter` / `batchFilter` 各一套），未来应合并成统一筛选函数。

---

## 10. 踩过的坑（别再踩）

| 坑 | 现象 | 解法 |
|---|---|---|
| `.cmd` 编码 | 中文路径乱码、变量没设上 | **UTF-8 无 BOM + CRLF + 首行 `chcp 65001`**，缺一不可 |
| `.ps1` 编码 | 中文目录创成乱码（`澶囦唤`） | 存成 **UTF-8 带 BOM** |
| `.cmd` 带 BOM | cmd.exe 把 BOM 当乱码执行 | `.cmd` 必须无 BOM |
| `local-paths.cmd` LF 行尾 | 变量不生效 | 必须 CRLF |
| 端口占用 | 双击后立刻退出 | 已有实例在跑，关旧窗口 |
| `migrate_table` 重建表 | 新加的列下次启动消失 | 三处同步改 |
| 反白名单统计 | 新 type 混进收支统计 | 全局搜 `not in` |
| 浏览器缓存 | 改了没效果 | 升 `index.html` 里的 `?v=` 版本号 |

---

## 11. 改代码的流程

1. 备份（代码 + 数据库，带时间戳）
2. 改 `scripts/` 里的主代码
3. **同步到 `程序/scripts/`**
4. 语法检查：`node --check dashboard.js` + `python -c "import ast;ast.parse(open(f,encoding='utf-8').read())"`
5. 起服务实测（用 8799 等空闲端口，别占 8765）
6. 验证数据：`entries` 条数、各状态计数、六账户余额
7. `git add -A --dry-run` 确认无数据文件后提交

---

## 12. 当前进度与方向

**已完成**：分类体系、三视角账单、名单机制（置顶/复制/管理条目）、待确认批量、质量扫描、期初余额（倒推/定位）、四格式导入、账户对账（六账户精确对上真实值）。

**用户核心诉求（下一步）**：
> 给一套筛选条件起个名字当「系统」，一键切换看各自统计。

这需要先把碎片化筛选统一成一个函数（支持 AND/OR/排除），再加一张 `saved_filter` 表。
**在此之前不建议继续堆功能。**

**明确不做**：复式记账改造、exe 打包（杀软误报）、云端同步、标签嵌套。
