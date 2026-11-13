# My Economic（我的经济）

个人财产记录与管理工具（本地 SQLite，数据不出本机）。

> ⚠️ **本仓库只包含代码。**
> 真实账本数据库（`bookkeeping.db`）与个人分类配置（`config.yaml`）存放在**仓库之外**的本地目录，
> 已在 `.gitignore` 中排除，不会、也不应该提交到本仓库。

---

## 直接使用（免安装）

不想折腾环境的话，直接拿仓库里的 **`程序/`** 文件夹：

1. 下载整个仓库（或只下载 `程序/` 文件夹）
2. 双击 **`程序/开始使用.cmd`**
3. 程序会自动建好数据目录、在桌面放一个快捷方式、启动服务并打开浏览器

`程序/python/` 里自带 Python 运行环境（约 22MB），**不需要另外安装 Python**。

| 内容 | 位置 |
|---|---|
| 账本数据库 | `程序/data/bookkeeping.db`（首次运行自动创建） |
| 分类配置 | `程序/data/config.yaml` |
| 自动备份 | `程序/backup/`（保留最近 30 份） |

这些都在 `.gitignore` 里排除，不会上传。

> `程序/scripts/` 是代码的发布副本。改了代码要同步一次进去，否则两处会不一致。

---

## 来源与许可

本项目基于 **[bingchuH/Bookkeeping](https://github.com/bingchuH/Bookkeeping)** 修改。

| | |
|---|---|
| **原始版权** | Copyright (c) 2026 **bingchuH**，MIT 许可证 |
| **修改部分版权** | Copyright (c) 2026 **jonem-bil**，同样以 MIT 许可证发布 |

MIT 许可证允许修改、商用与再分发，条件是**保留原始版权声明与许可正文**。
完整声明见 [`LICENSE`](LICENSE)；原项目文档保留在 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md)。

---

## 相比原项目的改动

1. **分类体系改造**
   - 移除"系统推荐分类"，改为用户自建的两级分类树（大分类 → 小分类）
   - 后端支持大分类的**级联改名 / 删除**（原版只要有子分类就改不动）
   - 删除分类时，受影响账目自动退回「待确认」，不留孤儿分类

2. **账单页三入口**
   - 条目统计（原始账目表格 + 文字搜索）
   - 按分类查找（大分类 → 小分类 → 账目，只读，带月份标签）
   - 交互消费统计（按消费对象聚合、可拆分到小分类、支持白名单/大额名单）

3. **归类效率**
   - 待确认页支持**批量确认**（按交易对象聚合，带金额/日期筛选与排序）
   - **误选撤销**：可退回上一条已确认的账目
   - 所有列表都可「只改分类」

4. **数据安全**
   - 关键词规则自动归类开关（`app_settings.auto_apply_rules`）
   - 每次启动看板自动备份数据库，保留最近 30 份

5. **对账能力**
   - 支持导入银行流水 PDF 并与账本逐笔核对（详见 `docs/`）

---

## 目录结构

```
financial/
├─ SKILL.md                  # 技能说明（给 AI Agent 读）
├─ bk.cmd                    # 命令行入口
├─ serve.cmd                 # 启动看板服务
├─ 打开看板.cmd               # 双击入口（探测端口 → 起服务 → 开浏览器）
├─ backup-db.ps1             # 数据库自动备份脚本
├─ config.example.yaml       # 分类树模板（复制为 scripts/config.yaml 使用）
├─ scripts/
│   ├─ bookkeeping.py        # 核心：CLI + HTTP 服务 + 数据层
│   ├─ bookkeeping_app/
│   │   └─ static/           # 前端：index.html / dashboard.js / dashboard.css
│   ├─ import_alipay_bill.py # 支付宝账单 → 标准 CSV
│   ├─ import_wechat_bill.py # 微信账单（xlsx）→ 标准 CSV
│   ├─ import_bill.py
│   ├─ init_db.py
│   └─ dashboard.py
└─ docs/
    ├─ UPSTREAM-README.md    # 原项目 README
    └─ images/Dashboard.jpg
```

---

## 运行

```powershell
# 1. 准备配置（首次使用）
copy config.example.yaml scripts\config.yaml
#    然后按自己的习惯修改分类树和账户名

# 2. 初始化数据库
.\bk.cmd init-db

# 3. 启动看板
.\serve.cmd
#    浏览器打开 http://127.0.0.1:8765
```

数据库路径通过环境变量 `BOOKKEEPING_DB_PATH` 指定，默认落在 `data/bookkeeping.db`（已被 git 忽略）。

---

## 隐私说明

本工具的所有数据都保存在本地 SQLite 文件中，不上传任何服务器。
**请勿将 `bookkeeping.db`、`config.yaml` 或任何导出的账单 CSV 提交到本仓库。**
