    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
    const money = (cents) => (Number(cents || 0) / 100).toFixed(2);
    const increaseTypes = new Set(['收入', '借入', '收款']);
    const decreaseTypes = new Set(['支出', '借出', '还款']);
    // 计入账户余额、但**不计入收支统计**的类型（与后端 NON_REPORTING_TYPES 保持一致）。
    // 注意：increaseTypes / decreaseTypes 故意不包含「期初资金」，否则它会被算成收入。
    const nonReportingTypes = new Set(['转账', '余额修正', '期初资金']);
    const isNonReporting = (row) => !!row && (nonReportingTypes.has(row.type) || row.category === '转账');
    // 后端 ENTRY_TYPES 全集（与 bookkeeping.py 的 ENTRY_TYPES 保持一致）。
    // 「余额修正 / 期初资金」这两类不需要分类，因此不会出现在 config.yaml 的 categories 里，
    // 也就不会出现在 categoryTree 的 key 中——但它们是合法账目类型，
    // 类型筛选下拉、编辑面板的类型下拉都必须能选到，否则改不了也筛不出。
    const ALL_ENTRY_TYPES = ['支出', '收入', '转账', '借入', '借出', '还款', '收款', '余额修正', '期初资金'];
    function entryTypeList() {
      const fromTree = Object.keys(categoryTree || {});
      return [...fromTree, ...ALL_ENTRY_TYPES.filter(type => !fromTree.includes(type))];
    }
    let pendingAnimating = false;
    let entries = [];
    let accountBalances = [];
    let debtBalances = [];
    let pendingItems = [];
    let categoryOptions = [];
    let categoryTree = {};
    let accountOptions = [];
    let accountFilterOptions = [];
    let keywordRules = [];
    let summaryData = null;
    let periodMode = 'month';
    let cycleMode = 'quarter';
    let selectedCycleIndex = 0;
    let yearOffset = 0;
    let monthOffset = 0;
    let customStart = '';
    let customEnd = '';
    let periodInitialized = false;
    let activeDateTarget = null;
    let pickerMonth = new Date();
    let entryPage = 1;
    let entryPageSize = localStorage.getItem('bookkeeping.entryPageSize') || '50';
    let editingEntryId = null;
    let entryFilters = {year: '', month: '', day: '', type: '', category: '', account: '', transaction_object: '', tone: '', start: '', end: '', minAmount: '', maxAmount: ''};
    let entryTypes = [];
    let pendingDelete = null;
    let pendingCategoryDelete = null;
    let pendingDebtDelete = null;
    let pendingAccountDelete = null;
    let pickerGroupState = {};
    let pendingSkippedIds = JSON.parse(localStorage.getItem('bookkeeping.pendingSkippedIds') || '[]');
    let expenseCategoryLevel = localStorage.getItem('bookkeeping.expenseCategoryLevel') || 'major';
    let editingCategoryKey = null;
    let addingKeywordKey = null;
    let editingAccountName = null;
    let editingAccountBalanceName = null;
    // 期初余额（账户开始记账前本来就有的钱）编辑态；与「余额」编辑态互斥。
    let editingAccountInitialName = null;
    // 「按当前实际余额倒推期初」的输入态：存账户名，该行期初列切成输入框。
    let backfillAccountName = null;
    // 账户页「定位期初」面板的状态：account=null 表示面板关闭（不弹窗、不跳页，就地展开）。
    // 默认「全部历史（days=0）+ 单笔 ≥ 100 元」，与「设完期初弹的 近10天≥500 提示」互不影响。
    const LOCATE_INITIAL_DEFAULTS = {minAmount: '100', days: '0'};
    let locateInitialState = {account: null, minAmount: LOCATE_INITIAL_DEFAULTS.minAmount, days: LOCATE_INITIAL_DEFAULTS.days};
    let locateInitialPayload = null;
    let entryNumberMap = {};
    let appSettings = {};
    let counterpartyListItems = [];
    let listDefs = [];
    let entryViewMode = 'list';
    let browserType = '';
    let browserGroup = '';
    let browserLeaf = '';
    let browserMonth = '';
    let counterpartyObject = '';
    let counterpartyMonth = '';
    // 消费对象详情的日期范围筛选（空 = 用该对象的最早 ~ 最晚流水）
    let cpDateFrom = '';
    let cpDateTo = '';
    let cpHiddenKinds = new Set();
    let cpMode = 'object';
    let cpSort = 'total';
    let cpAmountSort = 'total';
    let cpSortAsc = false;
    let cpFilter = {month: '', day: '', minCount: '', maxCount: '', minAmount: '', maxAmount: ''};
    let cpPanel = '';
    let cpPanelEdit = false;
    let cpMenuOpen = '';
    let rulePanelTab = 'category';
    let rulePanelType = '';
    let rulePanelLeaf = '';
    let rulePanelEdit = false;
    let pendingHistory = [];
    let pendingBatchMode = false;
    let batchFilter = {min: '', max: '', from: '', to: '', sort: 'count'};
    let batchSelected = new Set();
    let quickPickEntryId = null;
    let quickPickGroup = '';
    let quickPickPickedCategory = '';
    // 改分类撤销提示（页面上方，8 秒自动消失）
    let categoryUndo = null;
    // 设置页「特殊名单」（现在叫「选择名单」，收在规则与筛选中台里）
    let specialListOpen = false;
    // 设置页「规则与筛选中台 → 修改分类」折叠态（默认收起，不持久化）
    let categoryHubOpen = false;
    // 设置页「导入账单」面板
    let importPanelOpen = false;
    let importPreviewData = null;
    let importBusy = false;
    let specialListEditing = null;   // {mode:'rename', key, label}
    let specialListDeleteKey = '';
    let specialListMsg = '';
    let specialListManageKey = '';   // 正在「管理条目」的名单 key
    let specialListManageQuery = ''; // 候选消费对象搜索词
    let newListDialogAutoPin = false; // 新建名单对话框：建好是否自动置顶占快捷位
    // 交互消费统计顶部快捷位数量
    const CP_SLOT_COUNT = 3;
    // 按对象批量：展开详情 / 单条暂时隐藏
    let batchView = 'groups';        // groups | detail | hidden
    let batchDetailObject = '';
    let batchHiddenScope = '';
    let batchHiddenIds = readBatchHiddenKeys();
    // 收支趋势图：bar（默认）| line
    let trendChartMode = localStorage.getItem('bookkeeping.trendChartMode') === 'line' ? 'line' : 'bar';
    let lastTrendPoints = null;

    async function api(path, options) {
      const requestOptions = {...(options || {}), cache: 'no-store'};
      const res = await fetch(path, requestOptions);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      return data;
    }

    function savePendingSkippedIds() {
      localStorage.setItem('bookkeeping.pendingSkippedIds', JSON.stringify(pendingSkippedIds));
    }

    function orderPendingItems(items) {
      const itemKey = item => String(item.ui_id || item.id);
      const availableIds = new Set(items.map(itemKey));
      pendingSkippedIds = pendingSkippedIds.filter(id => availableIds.has(String(id)));
      savePendingSkippedIds();
      const skippedIndex = new Map(pendingSkippedIds.map((id, index) => [String(id), index]));
      return [...items].sort((a, b) => {
        const ai = skippedIndex.has(itemKey(a)) ? skippedIndex.get(itemKey(a)) : -1;
        const bi = skippedIndex.has(itemKey(b)) ? skippedIndex.get(itemKey(b)) : -1;
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return -1;
        if (bi === -1) return 1;
        return ai - bi;
      });
    }

    function signedMoney(cents, tone = 'neutral') {
      const value = Math.abs(Number(cents || 0)) / 100;
      const sign = tone === 'income' ? '+' : tone === 'expense' ? '-' : Number(cents || 0) < 0 ? '-' : '+';
      return `${sign}${value.toFixed(2)}`;
    }

    function balanceMoney(cents) {
      const value = Number(cents || 0) / 100;
      return value < 0 ? `-${Math.abs(value).toFixed(2)}` : value.toFixed(2);
    }

    function moneyTone(row) {
      if (!row) return 'neutral';
      // 「期初资金」= 本金注入（存钱 / 别人汇入）：它让余额增加，但不是收入，
      // 所以金额用中性色，不显示成绿色收入、也不显示成红色支出。
      if (row.type === '期初资金') return 'neutral';
      if (row.type === '余额修正') return 'neutral';
      if (increaseTypes.has(row.type)) return 'income';
      if (decreaseTypes.has(row.type)) return 'expense';
      return 'neutral';
    }

    // 只有真正参与收支统计的账目才能进 KPI / 趋势图 / 分类占比。
    // 转账、余额修正、期初资金都属于「计余额、不计收支」，一律排除。
    function reportableEntry(row) {
      return row && row.type !== '转账' && row.type !== '余额修正'
        && row.type !== '期初资金' && row.category !== '转账';
    }

    function moneyClass(_value, row) {
      const tone = moneyTone(row);
      return `money-cell ${tone === 'income' ? 'income' : tone === 'expense' ? 'expense' : 'neutral-money'}`;
    }

    function signedEntryMoney(cents, row) {
      return signedMoney(cents, moneyTone(row));
    }

    function amountValue(cents) {
      return (Math.abs(Number(cents || 0)) / 100).toFixed(2);
    }

    function nowDatetimeLocal() {
      const date = new Date();
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      return date.toISOString().slice(0, 16);
    }

    function datetimeInputValue(value) {
      return String(value || '').replace(' ', 'T').slice(0, 16);
    }

    function optionsHtml(options, selected, allowBlank = false) {
      const values = [...new Set(options.filter(value => value !== undefined && value !== null && String(value).trim() !== '').map(String))];
      if (selected && !values.includes(String(selected))) values.unshift(String(selected));
      const blank = allowBlank ? '<option value=""></option>' : '';
      return blank + values.map(value => `<option value="${esc(value)}" ${String(value) === String(selected || '') ? 'selected' : ''}>${esc(value)}</option>`).join('');
    }

    function categoryLabel(category) {
      return String(category || '').replaceAll('/', '·');
    }

    function majorCategory(category) {
      const value = String(category || '').trim();
      if (!value || value === '未分类') return '未分类';
      return value.split('/')[0] || value;
    }

    function cleanCategoryName(value) {
      return String(value ?? '').split('/').join('').split(String.fromCharCode(92)).join('').trim();
    }

    function categoryOptionsHtml(options, selected, allowBlank = false) {
      const values = [...new Set(options.filter(value => value !== undefined && value !== null && String(value).trim() !== '').map(String))];
      if (selected && !values.includes(String(selected))) values.unshift(String(selected));
      const blank = allowBlank ? '<option value=""></option>' : '';
      return blank + values.map(value => `<option value="${esc(value)}" ${String(value) === String(selected || '') ? 'selected' : ''}>${esc(categoryLabel(value))}</option>`).join('');
    }

    function uniqueEntryValues(field) {
      return [...new Set(entries.map(entry => String(entry[field] || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    }

    function entryFilterCategoryOptions() {
      return entryFilters.type ? categoriesForType(entryFilters.type) : categoryOptions;
    }

    function filterValueLabel(field) {
      if (field === 'category') return categoryLabel(entryFilters.category);
      return entryFilters[field] || '';
    }

    function entryDateParts() {
      const years = [...new Set(entries.map(entry => entryDay(entry).slice(0, 4)).filter(Boolean))].sort().reverse();
      const months = Array.from({length: 12}, (_, i) => pad2(i + 1));
      const maxDay = entryFilters.year && entryFilters.month ? new Date(Number(entryFilters.year), Number(entryFilters.month), 0).getDate() : 31;
      const days = Array.from({length: maxDay}, (_, i) => pad2(i + 1));
      return {years, months, days};
    }

    function syncEntryDateRange() {
      const selectedDay = String(entryFilters.day || '').includes('-') ? String(entryFilters.day).slice(8, 10) : entryFilters.day;
      entryFilters.start = '';
      entryFilters.end = '';
      if (!entryFilters.year) {
        entryFilters.month = '';
        entryFilters.day = '';
        return;
      }
      if (!entryFilters.month) {
        entryFilters.start = `${entryFilters.year}-01-01`;
        entryFilters.end = `${entryFilters.year}-12-31`;
        return;
      }
      const lastDay = pad2(new Date(Number(entryFilters.year), Number(entryFilters.month), 0).getDate());
      if (!selectedDay) {
        entryFilters.day = '';
        entryFilters.start = `${entryFilters.year}-${entryFilters.month}-01`;
        entryFilters.end = `${entryFilters.year}-${entryFilters.month}-${lastDay}`;
        return;
      }
      entryFilters.day = `${entryFilters.year}-${entryFilters.month}-${selectedDay}`;
    }

    function clearEntryFilters() {
      entryFilters = {year: '', month: '', day: '', type: '', category: '', account: '', transaction_object: '', tone: '', start: '', end: '', minAmount: '', maxAmount: ''};
    }

    function entryAmountFilterText() {
      const min = String(entryFilters.minAmount || '').trim();
      const max = String(entryFilters.maxAmount || '').trim();
      if (!min && !max) return '';
      if (min && max) return `${min} ~ ${max}`;
      return min ? `≥ ${min}` : `≤ ${max}`;
    }

    function amountHeaderCell() {
      const text = entryAmountFilterText();
      return `
        <th>
          <div class="entry-head-filter entry-amount-head ${text ? 'is-active' : ''}">
            <span class="entry-head-label">金额<span class="entry-head-arrow">⌄</span></span>
            ${text ? `<span class="entry-head-value">${esc(text)}</span>` : ''}
            <div class="entry-amount-inputs">
              <input data-entry-amount="minAmount" type="number" step="0.01" min="0" placeholder="≥" value="${esc(entryFilters.minAmount)}" aria-label="金额下限" title="金额下限（元）">
              <input data-entry-amount="maxAmount" type="number" step="0.01" min="0" placeholder="≤" value="${esc(entryFilters.maxAmount)}" aria-label="金额上限" title="金额上限（元）">
            </div>
          </div>
        </th>`;
    }

    function headerFilterCell(field, label, options, attrs = '') {
      const html = field === 'category' ? categoryOptionsHtml(options, entryFilters[field], true) : optionsHtml(options, entryFilters[field], true);
      const value = filterValueLabel(field);
      return `
        <th>
          <div class="entry-head-filter ${value ? 'is-active' : ''}">
            <span class="entry-head-label">${esc(label)}<span class="entry-head-arrow">⌄</span></span>
            ${value ? `<span class="entry-head-value">${esc(value)}</span>` : ''}
            <select data-entry-filter="${field}" aria-label="${esc(label)}" ${attrs}>${html}</select>
          </div>
        </th>`;
    }

    function dateHeaderCell() {
      const {years, months, days} = entryDateParts();
      const dayPart = String(entryFilters.day || '').includes('-') ? String(entryFilters.day).slice(8, 10) : entryFilters.day;
      const dateText = entryFilters.year
        ? [entryFilters.year, entryFilters.month, dayPart].filter(Boolean).join('/')
        : '';
      return `
        <th>
          <div class="entry-head-filter entry-time-head ${dateText ? 'is-active' : ''}">
            <span class="entry-head-label">时间<span class="entry-head-arrow">⌄</span></span>
            ${dateText ? `<span class="entry-head-value">${esc(dateText)}</span>` : ''}
            <div class="entry-time-selects">
              <select data-entry-filter="year" aria-label="年">${optionsHtml(years, entryFilters.year, true)}</select>
              <select data-entry-filter="month" aria-label="月" ${entryFilters.year ? '' : 'disabled'}>${optionsHtml(months, entryFilters.month, true)}</select>
              <select data-entry-filter="day" aria-label="日" ${entryFilters.year && entryFilters.month ? '' : 'disabled'}>${optionsHtml(days, dayPart, true)}</select>
            </div>
          </div>
        </th>`;
    }

    function entryMatchesFilters(entry) {
      const day = entryDay(entry);
      if (entryFilters.day && day !== entryFilters.day) return false;
      if (entryFilters.start && day < entryFilters.start) return false;
      if (entryFilters.end && day > entryFilters.end) return false;
      if (entryFilters.type && entry.type !== entryFilters.type) return false;
      if (entryFilters.category && (entry.category || '') !== entryFilters.category) return false;
      if (entryFilters.account && (entry.account || '') !== entryFilters.account) return false;
      if (entryFilters.transaction_object && (entry.transaction_object || '') !== entryFilters.transaction_object) return false;
      if (entryFilters.tone && moneyTone(entry) !== entryFilters.tone) return false;
      const minAmount = String(entryFilters.minAmount || '').trim();
      const maxAmount = String(entryFilters.maxAmount || '').trim();
      if (minAmount || maxAmount) {
        const amount = Math.abs(Number(entry.amount_cents) || 0) / 100;
        if (minAmount && !Number.isNaN(Number(minAmount)) && amount < Number(minAmount)) return false;
        if (maxAmount && !Number.isNaN(Number(maxAmount)) && amount > Number(maxAmount)) return false;
      }
      return true;
    }

    function entryMatchesSearch(entry, query, mode) {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return true;
      if (mode === 'category') {
        const category = String(entry.category || '');
        if (!category) return false;
        return category.toLowerCase().includes(needle)
          || categoryLabel(category).toLowerCase().includes(needle)
          || majorCategory(category).toLowerCase().includes(needle);
      }
      if (mode === 'keyword') {
        return [entry.transaction_object, entry.note, entry.participant]
          .some(value => String(value || '').toLowerCase().includes(needle));
      }
      return JSON.stringify(entry).toLowerCase().includes(needle);
    }

    function syncSearchModeUi() {
      const select = $('searchMode');
      if (!select) return;
      const input = $('search');
      const mode = select.value;
      input.placeholder = mode === 'category' ? '按分类搜索：输入 大分类 或 小分类 名称'
        : mode === 'keyword' ? '按关键词搜索：交易对象 / 备注 / 参与人'
        : '搜索账单、备注、账户';
      input.title = input.placeholder;
      select.title = '搜索方式';
    }

    function entryFilterSummary() {
      const parts = [];
      if (entryFilters.tone === 'income') parts.push('收入账单');
      if (entryFilters.tone === 'expense') parts.push('支出账单');
      if (entryFilters.start || entryFilters.end) parts.push(`${slashDate(entryFilters.start)} - ${slashDate(entryFilters.end)}`);
      if (entryFilters.day) parts.push(slashDate(entryFilters.day));
      ['type', 'category', 'account', 'transaction_object'].forEach(field => {
        if (entryFilters[field]) parts.push(field === 'category' ? categoryLabel(entryFilters[field]) : entryFilters[field]);
      });
      if (entryAmountFilterText()) parts.push(`金额 ${entryAmountFilterText()}`);
      return parts.join(' / ');
    }

    function clearDeleteToast() {
      const toast = $('deleteToast');
      if (toast) toast.remove();
    }

    function renderDeleteToast() {
      clearDeleteToast();
      const pending = pendingDelete || pendingCategoryDelete || pendingDebtDelete || pendingAccountDelete;
      if (!pending) return;
      const toast = document.createElement('div');
      toast.id = 'deleteToast';
      toast.className = 'delete-toast';
      const labels = {
        account: `已移除账户 ${pending.row.name}`,
        category: `已移除分类 ${categoryLabel(pending.category)}`,
        debt: `已移除 ${pending.row.name}`,
        entry: '已移除 1 条账单',
      };
      const label = labels[pending.kind || 'entry'];
      toast.innerHTML = `
        <span>${esc(label)}</span>
        <button data-undo-delete>撤销(${pending.remaining}s)</button>`;
      document.body.appendChild(toast);
      toast.querySelector('[data-undo-delete]').onclick = pending.kind === 'category'
        ? undoPendingCategoryDelete
        : pending.kind === 'debt'
          ? undoPendingDebtDelete
          : pending.kind === 'account'
            ? undoPendingAccountDelete
            : undoPendingDelete;
    }

    function pendingDeleteRequest(item) {
      if ((item.kind || 'entry') === 'category') {
        return {path: '/api/category-delete', body: {type: item.type, category: item.category}};
      }
      if (item.kind === 'debt') {
        return {path: '/api/account-debt-delete', body: {id: item.row.id}};
      }
      if (item.kind === 'account') {
        return {path: '/api/account-delete', body: {name: item.row.name}};
      }
      return {path: '/api/entry-delete', body: {id: item.row.id}};
    }

    function sendPendingDelete(item, keepalive = false) {
      const request = pendingDeleteRequest(item);
      const body = JSON.stringify(request.body);
      if (keepalive) {
        const blob = new Blob([body], {type: 'application/json'});
        if (navigator.sendBeacon && navigator.sendBeacon(request.path, blob)) return Promise.resolve();
        return fetch(request.path, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body,
          keepalive: true
        }).catch(() => {});
      }
      return api(request.path, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body
      });
    }

    function takePendingDeletes() {
      const items = [pendingDelete, pendingCategoryDelete, pendingDebtDelete, pendingAccountDelete].filter(Boolean);
      pendingDelete = null;
      pendingCategoryDelete = null;
      pendingDebtDelete = null;
      pendingAccountDelete = null;
      items.forEach(item => {
        clearInterval(item.intervalId);
        clearTimeout(item.timeoutId);
      });
      clearDeleteToast();
      return items;
    }

    async function commitPendingDeletes(options = {}) {
      const items = takePendingDeletes();
      if (!items.length) return;
      try {
        await Promise.all(items.map(item => sendPendingDelete(item, Boolean(options.keepalive))));
        if (options.refreshAfter) await refresh();
      } catch (err) {
        if (options.refreshAfter) await refresh();
        if (!options.silent) alert(err.message === 'not found' ? '后端接口未加载，请重启 Dashboard 后再删除。' : err.message);
      }
    }

    async function finalizePendingDelete() {
      if (!pendingDelete) return;
      const item = pendingDelete;
      pendingDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      try {
        await api('/api/entry-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id: item.row.id})
        });
        await refresh();
      } catch (err) {
        if (!entries.some(entry => Number(entry.id) === Number(item.row.id))) {
          entries.splice(Math.min(item.index, entries.length), 0, item.row);
        }
        renderEntries();
        alert(err.message === 'not found' ? '后端接口未加载，请重启 Dashboard 后再删除。' : err.message);
      }
    }

    function undoPendingDelete() {
      if (!pendingDelete) return;
      const item = pendingDelete;
      pendingDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      if (!entries.some(entry => Number(entry.id) === Number(item.row.id))) {
        entries.splice(Math.min(item.index, entries.length), 0, item.row);
      }
      renderEntries();
    }

    // ── 改分类撤销提示：样式复用 .delete-toast，位置固定在页面上方 ──
    function clearCategoryUndoToast() {
      const toast = $('categoryUndoToast');
      if (toast) toast.remove();
    }

    function clearCategoryUndoTimers() {
      if (!categoryUndo) return;
      clearInterval(categoryUndo.intervalId);
      clearTimeout(categoryUndo.timeoutId);
      categoryUndo.intervalId = null;
      categoryUndo.timeoutId = null;
    }

    function renderCategoryUndoToast() {
      clearCategoryUndoToast();
      if (!categoryUndo) return;
      const toast = document.createElement('div');
      toast.id = 'categoryUndoToast';
      toast.className = 'delete-toast undo-toast-top';
      const from = categoryLabel(categoryUndo.fromCategory) || '未分类';
      toast.innerHTML = `
        <span>已改为「${esc(categoryLabel(categoryUndo.toCategory) || '未分类')}」（原：${esc(from)}），是否撤销改动？</span>
        <button type="button" data-undo-category>撤销(${categoryUndo.remaining}s)</button>`;
      document.body.appendChild(toast);
      const btn = toast.querySelector('[data-undo-category]');
      if (btn) btn.onclick = () => undoCategoryChange();
    }

    function armCategoryUndoTimers(seconds = 8) {
      if (!categoryUndo) return;
      clearInterval(categoryUndo.intervalId);
      clearTimeout(categoryUndo.timeoutId);
      categoryUndo.remaining = seconds;
      categoryUndo.intervalId = setInterval(() => {
        if (!categoryUndo) return;
        categoryUndo.remaining -= 1;
        if (categoryUndo.remaining < 0) return;
        const btn = $('categoryUndoToast')?.querySelector('[data-undo-category]');
        if (btn) btn.textContent = `撤销(${categoryUndo.remaining}s)`;
      }, 1000);
      categoryUndo.timeoutId = setTimeout(() => {
        if (!categoryUndo) return;
        clearCategoryUndoTimers();
        categoryUndo = null;
        clearCategoryUndoToast();
      }, seconds * 1000);
    }

    function showCategoryUndoToast(payload) {
      // 新提示覆盖旧提示，不堆叠
      clearCategoryUndoTimers();
      categoryUndo = {...payload, remaining: 8, intervalId: null, timeoutId: null};
      armCategoryUndoTimers(8);
      renderCategoryUndoToast();
    }

    async function undoCategoryChange() {
      if (!categoryUndo) return;
      const pending = categoryUndo;
      clearCategoryUndoTimers();
      try {
        await api('/api/entry-category', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            id: pending.id,
            category: pending.fromCategory,
            restore_status: pending.fromStatus
          })
        });
        categoryUndo = null;
        clearCategoryUndoToast();
        await refresh();
        $('status').textContent = `已撤销分类改动，恢复为「${categoryLabel(pending.fromCategory) || '未分类'}」`;
      } catch (err) {
        // 撤销失败：给出错误提示，提示条继续保留可再点，界面不卡住
        $('status').textContent = `撤销失败：${err.message}`;
        categoryUndo = pending;
        armCategoryUndoTimers(8);
        renderCategoryUndoToast();
      }
    }

    function scheduleEntryDelete(id) {
      if (pendingCategoryDelete) finalizePendingCategoryDelete();
      if (pendingDebtDelete) finalizePendingDebtDelete();
      if (pendingAccountDelete) finalizePendingAccountDelete();
      if (pendingDelete) finalizePendingDelete();
      const index = entries.findIndex(entry => Number(entry.id) === Number(id));
      if (index < 0) return;
      const [row] = entries.splice(index, 1);
      if (editingEntryId === Number(id)) editingEntryId = null;
      pendingDelete = {row, index, remaining: 5, intervalId: null, timeoutId: null};
      pendingDelete.intervalId = setInterval(() => {
        if (!pendingDelete || pendingDelete.row.id !== row.id) return;
        pendingDelete.remaining -= 1;
        renderDeleteToast();
      }, 1000);
      pendingDelete.timeoutId = setTimeout(finalizePendingDelete, 5000);
      renderEntries();
      renderDeleteToast();
    }

    async function finalizePendingCategoryDelete() {
      if (!pendingCategoryDelete) return;
      const item = pendingCategoryDelete;
      pendingCategoryDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      try {
        await api('/api/category-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({type: item.type, category: item.category})
        });
        await refresh();
      } catch (err) {
        renderCategoryRules();
        renderCategoryEditor();
        alert(err.message === 'not found' ? '后端接口未加载，请重启 Dashboard 后再删除。' : err.message);
      }
    }

    function undoPendingCategoryDelete() {
      if (!pendingCategoryDelete) return;
      const item = pendingCategoryDelete;
      pendingCategoryDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      renderCategoryRules();
    }

    function scheduleCategoryDelete(type, category) {
      if (pendingDelete) finalizePendingDelete();
      if (pendingDebtDelete) finalizePendingDebtDelete();
      if (pendingAccountDelete) finalizePendingAccountDelete();
      if (pendingCategoryDelete) finalizePendingCategoryDelete();
      if (editingCategoryKey === `${type}|||${category}`) editingCategoryKey = null;
      if (addingKeywordKey === `${type}|||${category}`) addingKeywordKey = null;
      pendingCategoryDelete = {kind: 'category', type, category, remaining: 5, intervalId: null, timeoutId: null};
      pendingCategoryDelete.intervalId = setInterval(() => {
        if (!pendingCategoryDelete || pendingCategoryDelete.type !== type || pendingCategoryDelete.category !== category) return;
        pendingCategoryDelete.remaining -= 1;
        renderDeleteToast();
      }, 1000);
      pendingCategoryDelete.timeoutId = setTimeout(finalizePendingCategoryDelete, 5000);
      renderCategoryRules();
      renderDeleteToast();
    }

    async function finalizePendingDebtDelete() {
      if (!pendingDebtDelete) return;
      const item = pendingDebtDelete;
      pendingDebtDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      try {
        await api('/api/account-debt-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id: item.row.id})
        });
        await refresh();
      } catch (err) {
        if (!debtBalances.some(row => Number(row.id) === Number(item.row.id))) {
          debtBalances.splice(Math.min(item.index, debtBalances.length), 0, item.row);
        }
        $('debtList').innerHTML = renderDebtBalances(debtBalances);
        bindDebtActions();
        alert(err.message === 'not found' ? '后端接口未加载，请重启 Dashboard 后再删除。' : err.message);
      }
    }

    function undoPendingDebtDelete() {
      if (!pendingDebtDelete) return;
      const item = pendingDebtDelete;
      pendingDebtDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      if (!debtBalances.some(row => Number(row.id) === Number(item.row.id))) {
        debtBalances.splice(Math.min(item.index, debtBalances.length), 0, item.row);
      }
      $('debtList').innerHTML = renderDebtBalances(debtBalances);
      bindDebtActions();
    }

    function scheduleDebtDelete(id) {
      if (pendingDelete) finalizePendingDelete();
      if (pendingCategoryDelete) finalizePendingCategoryDelete();
      if (pendingAccountDelete) finalizePendingAccountDelete();
      if (pendingDebtDelete) finalizePendingDebtDelete();
      const index = debtBalances.findIndex(row => Number(row.id) === Number(id));
      if (index < 0) return;
      const [row] = debtBalances.splice(index, 1);
      pendingDebtDelete = {kind: 'debt', row, index, remaining: 5, intervalId: null, timeoutId: null};
      pendingDebtDelete.intervalId = setInterval(() => {
        if (!pendingDebtDelete || pendingDebtDelete.row.id !== row.id) return;
        pendingDebtDelete.remaining -= 1;
        renderDeleteToast();
      }, 1000);
      pendingDebtDelete.timeoutId = setTimeout(finalizePendingDebtDelete, 5000);
      $('debtList').innerHTML = renderDebtBalances(debtBalances);
      bindDebtActions();
      renderDeleteToast();
    }

    async function finalizePendingAccountDelete() {
      if (!pendingAccountDelete) return;
      const item = pendingAccountDelete;
      pendingAccountDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      try {
        await api('/api/account-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({name: item.row.name})
        });
        await refresh();
      } catch (err) {
        if (!accountBalances.some(row => row.name === item.row.name)) {
          accountBalances.splice(Math.min(item.index, accountBalances.length), 0, item.row);
        }
        $('assetList').innerHTML = renderAccountBalances(accountBalances);
        bindAccountActions();
        alert(err.message === 'cannot delete account with existing entries'
          ? '该账户已有账单或待确认记录，不能删除。'
          : err.message === 'not found'
            ? '后端接口未加载，请重启 Dashboard 后再删除。'
            : err.message);
      }
    }

    function undoPendingAccountDelete() {
      if (!pendingAccountDelete) return;
      const item = pendingAccountDelete;
      pendingAccountDelete = null;
      clearInterval(item.intervalId);
      clearTimeout(item.timeoutId);
      clearDeleteToast();
      if (!accountBalances.some(row => row.name === item.row.name)) {
        accountBalances.splice(Math.min(item.index, accountBalances.length), 0, item.row);
      }
      $('assetList').innerHTML = renderAccountBalances(accountBalances);
      bindAccountActions();
    }

    function scheduleAccountDelete(name) {
      if (pendingDelete) finalizePendingDelete();
      if (pendingCategoryDelete) finalizePendingCategoryDelete();
      if (pendingDebtDelete) finalizePendingDebtDelete();
      if (pendingAccountDelete) finalizePendingAccountDelete();
      const index = accountBalances.findIndex(row => row.name === name);
      if (index < 0) return;
      const [row] = accountBalances.splice(index, 1);
      if (editingAccountName === name) editingAccountName = null;
      if (editingAccountBalanceName === name) editingAccountBalanceName = null;
      if (editingAccountInitialName === name) editingAccountInitialName = null;
      if (backfillAccountName === name) backfillAccountName = null;
      pendingAccountDelete = {kind: 'account', row, index, remaining: 5, intervalId: null, timeoutId: null};
      pendingAccountDelete.intervalId = setInterval(() => {
        if (!pendingAccountDelete || pendingAccountDelete.row.name !== row.name) return;
        pendingAccountDelete.remaining -= 1;
        renderDeleteToast();
      }, 1000);
      pendingAccountDelete.timeoutId = setTimeout(finalizePendingAccountDelete, 5000);
      $('assetList').innerHTML = renderAccountBalances(accountBalances);
      bindAccountActions();
      renderDeleteToast();
    }

    function toneColor(tone) {
      const inverted = document.body.dataset.colorInverted === 'true';
      if (tone === 'income') return cssVar(inverted ? '--green' : '--red');
      if (tone === 'expense') return cssVar(inverted ? '--red' : '--green');
      return cssVar('--ink');
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    const ymd = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const slashDate = (value) => value ? value.replaceAll('-', '/') : '--/--/--';
    const entryDay = (entry) => String(entry.transaction_time || '').slice(0, 10);
    const parseDay = (value) => {
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    };
    const addDays = (date, days) => {
      const next = new Date(date);
      next.setDate(next.getDate() + days);
      return next;
    };

    function table(rows, columns) {
      if (!rows.length) return '<div class="muted">暂无数据</div>';
      return '<table><thead><tr>' + columns.map(c => `<th>${c[1]}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + columns.map(c => {
          const cls = c[3] ? ` class="${esc(c[3](r[c[0]], r))}"` : '';
          return `<td${cls}>${esc(c[2] ? c[2](r[c[0]], r) : r[c[0]])}</td>`;
        }).join('') + '</tr>').join('') +
        '</tbody></table>';
    }

    // 带符号的金额文本（流水净额用）：+1234.56 / -78.90
    const signedFlowText = value => {
      const n = Number(value || 0);
      return `${n < 0 ? '-' : '+'}${(Math.abs(n) / 100).toFixed(2)}`;
    };

    // 这个账户的余额是怎么算出来的。有余额修正就说明基于哪一天的修正，
    // 否则说「期初 + 流水净额」——两者都能让人一眼看出差在哪。
    function accountBasisHint(row) {
      if ((row.balance_basis || '') === '余额修正') {
        const day = String(row.balance_basis_time || '').slice(0, 10);
        return day ? `基于 ${day} 的余额修正` : '基于余额修正';
      }
      const base = Number(row.balance_base_cents ?? row.initial_balance_cents ?? 0);
      return `期初 ${balanceMoney(base)} + 流水 ${signedFlowText(row.net_flow_cents)}`;
    }

    function renderAccountBalances(rows) {
      const body = rows.length ? rows.map(row => {
        const value = row.computed_balance_cents ?? row.current_balance_cents;
        const initialValue = row.initial_balance_cents ?? 0;
        const isNameEditing = editingAccountName === row.name;
        const isBalanceEditing = editingAccountBalanceName === row.name;
        const isInitialEditing = editingAccountInitialName === row.name;
        const isBackfilling = backfillAccountName === row.name;
        const basisHint = accountBasisHint(row);
        const corrected = (row.balance_basis || '') === '余额修正';
        return `
          <tr>
            <td>
              <div class="account-name-cell">
                ${isNameEditing
                  ? `<input class="account-name-input" type="text" value="${esc(row.name)}" aria-label="账户名" data-account-name-input="${esc(row.name)}">`
                  : `<span>${esc(row.name)}</span>
                    <button type="button" class="icon-button" title="编辑账户名" aria-label="编辑账户名" data-account-name-edit="${esc(row.name)}">✎</button>`}
              </div>
            </td>
            <td class="money-cell neutral-money">
              <div class="account-initial-cell">
                ${isBackfilling
                  ? `<input class="account-balance-input" type="text" inputmode="decimal" placeholder="银行 App 里的真实余额" title="填你在银行 App 里看到的真实余额；期初 = 真实余额 − 这段时间的流水净额" data-account-backfill-input="${esc(row.name)}">`
                  : isInitialEditing
                    ? `<input class="account-balance-input" type="text" inputmode="decimal" value="${esc(money(initialValue))}" aria-label="期初余额" title="期初余额 = 开始记账那天之前这个账户里本来就有的钱；改它只会重算余额，不会产生任何账目记录" data-account-initial-input="${esc(row.name)}">`
                    : `<span title="开始记账之前这个账户里本来就有的钱">${esc(balanceMoney(initialValue))}</span>
                      <button type="button" class="icon-button" title="编辑期初余额（只改起点，不产生账目）" aria-label="编辑期初余额" data-account-initial-edit="${esc(row.name)}">✎</button>`}
              </div>
              ${isBackfilling
                ? `<div class="account-basis-hint">期初 = 你输入的实际余额 − 这段时间的流水净额（${signedFlowText(row.net_flow_cents)}）</div>`
                : `<div class="account-row-actions">
                    <button type="button" class="account-backfill-btn" data-account-backfill="${esc(row.name)}" ${corrected
                      ? 'disabled title="该账户已有余额修正记录，期初不参与重算，倒推不会生效"'
                      : 'title="按当前实际余额倒推期初"'}
                    >倒推</button>
                    <button type="button" class="account-backfill-btn${locateInitialState.account === row.name ? ' is-open' : ''}" data-account-locate="${esc(row.name)}" aria-expanded="${locateInitialState.account === row.name ? 'true' : 'false'}" title="在表格上方展开该账户的大额流入（默认全部历史、单笔 ≥ 100 元），勾选后可标记为「期初资金」">定位期初</button>
                  </div>`}
            </td>
            <td class="money-cell debt-money">
              <div class="account-balance-cell">
                ${isBalanceEditing
                  ? `<input class="account-balance-input" type="text" inputmode="decimal" value="${esc(money(value))}" aria-label="账户余额" placeholder="实际余额" title="这里只修正当前余额：会生成一条「余额修正」账目，不改动期初" data-account-balance-input="${esc(row.name)}">`
                  : `<span title="${esc(basisHint)}">${esc(balanceMoney(value))}</span>
                    <button type="button" class="icon-button" title="修正当前余额（生成一条「余额修正」账目，不改动期初）" aria-label="编辑余额" data-account-balance-edit="${esc(row.name)}">✎</button>`}
              </div>
              <div class="account-basis-hint" title="${esc(basisHint)}">${esc(basisHint)}</div>
            </td>
            <td>${esc(row.currency)}</td>
            <td class="account-actions"><button type="button" class="text-delete" data-account-delete="${esc(row.name)}">删除</button></td>
          </tr>
        `;
      }).join('') : '<tr><td class="entry-empty" colspan="5">暂无数据</td></tr>';
      return `<p class="account-hint">期初余额 = 你开始记账那天之前这个账户里本来有多少钱；改它只会重算余额，<strong>不会产生任何账目记录</strong>。余额列下方小字是它的构成：没有余额修正时显示「期初 + 流水净额」，显示「基于某日的余额修正」则表示该账户从那条修正起算、期初不再参与。</p>
      <table class="account-table">
        <thead><tr><th>账户</th><th>期初余额</th><th>余额</th><th>币种</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="account-add-form">
        <input id="newAccountName" type="text" placeholder="新增账户名称">
        <input id="newAccountBalance" type="text" inputmode="decimal" placeholder="初始余额" title="新增账户时填的就是它的期初余额（该账户还没有任何流水，所以初始余额 = 期初 = 当前余额）">
        <button type="button" class="primary" id="addAccount">新增账户</button>
      </div>`;
    }

    async function saveAccountName(input, oldName) {
      if (input.dataset.saving === 'true') return;
      const newName = input.value.trim();
      editingAccountName = null;
      if (!newName || newName === oldName) {
        $('assetList').innerHTML = renderAccountBalances(accountBalances);
        bindAccountActions();
        return;
      }
      input.dataset.saving = 'true';
      await api('/api/account-rename', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({old_name: oldName, new_name: newName})
      });
      await refresh();
    }

    // 「编辑余额」= 修正当前余额：走 /api/correct-balance，会生成一条「余额修正」账目。
    // 它不会动期初余额——这正是以前那版（走 /api/account-set）挖的坑：
    // set_account() 会把期初和当前余额同时写成同一个值，下次重算就翻倍。
    async function saveAccountBalance(input, name) {
      if (input.dataset.saving === 'true') return;
      const actual = input.value.trim();
      editingAccountBalanceName = null;
      backfillAccountName = null;
      if (!actual) {
        $('assetList').innerHTML = renderAccountBalances(accountBalances);
        bindAccountActions();
        return;
      }
      input.dataset.saving = 'true';
      await api('/api/correct-balance', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({account: name, actual})
      });
      await refresh();
    }

    // 「期初余额」保存：走 /api/account-initial-balance，只写 accounts.initial_balance_cents，
    // 后端会立刻重算并把结果写回 current_balance_cents，所以整块账户区刷新后余额马上跟着变。
    // 期初不产生任何账目记录，因此不影响收支统计。
    async function saveAccountInitial(input, name) {
      if (input.dataset.saving === 'true') return;
      const amount = input.value.trim();
      editingAccountInitialName = null;
      backfillAccountName = null;
      if (!amount) {
        $('assetList').innerHTML = renderAccountBalances(accountBalances);
        bindAccountActions();
        return;
      }
      input.dataset.saving = 'true';
      const result = await api('/api/account-initial-balance', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name, amount})
      });
      await refresh();
      // 期初与「余额修正」是互斥基准：存在修正记录时，期初写了也不会改变余额显示。
      if (result && result.corrected) {
        alert(`期初已保存为 ${result.initial_balance}，但这个账户存在「余额修正」记录，`
          + `余额重算以那条修正（${String(result.balance_basis_time || '').slice(0, 10)}）为基准，`
          + `所以余额数字暂时不会跟着变。`);
      }
      // 设完期初，顺便看看这个账户近期有没有「大额流入」可能属于本金注入
      await checkInitialFundCandidates(name);
    }

    // ═══════ 需求二：期初余额 → 大额流入候选提示（本金注入） ═══════
    // 后端接口是**纯只读**的，扫出 0 条是正常结果（记账期间本来就没有大额流入）。
    // 这里绝不自动改任何账目：必须用户勾选 + 二次确认才调 /api/initial-fund-mark。
    async function checkInitialFundCandidates(account) {
      const wrap = $('initialFundHint');
      if (!wrap) return;
      let payload = null;
      try {
        payload = await api(`/api/initial-fund-candidates?account=${encodeURIComponent(account)}`);
      } catch (err) {
        // 候选扫描失败不该阻塞期初保存，静默跳过（面板不出现）
        return;
      }
      if (!payload || !payload.count) {
        wrap.innerHTML = '';
        return;
      }
      renderInitialFundHint(payload);
    }

    function renderInitialFundHint(payload) {
      const wrap = $('initialFundHint');
      if (!wrap) return;
      const rows = payload.candidates.map(item => `
        <tr>
          <td><input type="checkbox" data-initial-fund-pick="${esc(item.id)}" checked></td>
          <td class="num-cell">${esc(item.entry_no)}</td>
          <td>${esc(item.transaction_time)}</td>
          <td>${esc(item.type)}</td>
          <td class="money-cell">${esc(signedMoney(item.amount_cents, 'income'))}</td>
          <td>${esc(categoryLabel(item.category) || '未分类')}</td>
          <td>${esc(item.transaction_object || '')}</td>
        </tr>`).join('');
      wrap.innerHTML = `
        <div class="initial-fund-hint" data-initial-fund-account="${esc(payload.account)}">
          <div class="initial-fund-hint-head">
            <strong>检测到该账户近 ${esc(payload.days)} 天有 ${esc(payload.count)} 笔大额流入</strong>
            <button type="button" class="icon-button" data-initial-fund-close aria-label="关闭">×</button>
          </div>
          <p class="muted">如果是本金注入（开卡后存钱 / 别人汇入），可以标记为「期初资金」——
            它们<strong>不再计入收入统计</strong>，但账户余额不受影响。勾选要标记的账目，再点「标记选中」。</p>
          <p class="muted">扫描窗口：${esc(payload.window_start)} ~ ${esc(payload.window_end)}
            · 单笔 ≥ ${esc(payload.min_amount)} 元 · 账户「${esc(payload.account)}」
            · 锚点：${esc(payload.anchor_basis || '')}</p>
          <table class="plain-table">
            <thead><tr><th>选</th><th>编号</th><th>时间</th><th>类型</th><th>金额</th><th>分类</th><th>交易对象</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="initial-fund-hint-actions">
            <button type="button" class="secondary" data-initial-fund-ignore>全部忽略</button>
            <button type="button" class="primary" data-initial-fund-mark>标记选中为期初资金</button>
          </div>
        </div>`;
      wrap.querySelector('[data-initial-fund-close]').onclick = () => { wrap.innerHTML = ''; };
      wrap.querySelector('[data-initial-fund-ignore]').onclick = () => { wrap.innerHTML = ''; };
      wrap.querySelector('[data-initial-fund-mark]').onclick = () =>
        markSelectedInitialFund(payload).catch(err => alert(err.message));
    }

    async function markSelectedInitialFund(payload) {
      const wrap = $('initialFundHint');
      if (!wrap) return;
      const ids = [...wrap.querySelectorAll('[data-initial-fund-pick]')]
        .filter(el => el.checked)
        .map(el => Number(el.dataset.initialFundPick));
      if (!ids.length) {
        alert('还没有勾选任何账目');
        return;
      }
      const picked = payload.candidates.filter(item => ids.includes(Number(item.id)));
      const totalCents = picked.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
      const detail = picked.map(item =>
        `  · ${item.transaction_time}  ${item.type}  ${item.amount} 元  ${item.transaction_object || ''}`
      );
      const ok = confirm(
        `把选中的 ${ids.length} 笔账目标记为「期初资金」（本金注入）：\n\n`
        + `${detail.join('\n')}\n\n`
        + `合计 ${money(totalCents)} 元。\n\n`
        + `改完会怎样：\n`
        + `  · 这些账目不再计入收入统计，对应月份的收入会减少 ${money(totalCents)} 元；\n`
        + `  · 账户余额不变（期初资金与收入同向，只是换了统计口径）；\n`
        + `  · 账目原本的金额、时间、账户一个都不改。\n\n`
        + `确定要改吗？`
      );
      if (!ok) return;
      const result = await api('/api/initial-fund-mark', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ids})
      });
      wrap.innerHTML = '';
      await refresh();
      const skipped = result.skipped || [];
      const skippedText = skipped.length
        ? `；跳过 ${skipped.length} 条（${skipped.map(row => `#${row.id}: ${row.reason}`).join('、')}）`
        : '';
      const status = $('status');
      if (status) {
        status.textContent = `已把 ${result.changed_count} 笔标记为期初资金，收入统计减少 ${result.removed_income} 元，账户余额不变${skippedText}`;
      }
    }

    // ═══════ 账户页「定位期初」按钮：随时手动翻历史找大额流入（本金注入） ═══════
    // 与上面「设完期初余额后弹的近 10 天 ≥ 500 提示」是两条互不干扰的路径：
    //   · 上面那条走 GET /api/initial-fund-candidates（默认 10 天 / 500 元，一个字没改）；
    //   · 这里走 GET /api/initial-fund-locate（默认全部历史 / 100 元，可调）。
    // 两者共用一个纯只读的后端函数，标记动作也共用已有的 POST /api/initial-fund-mark。
    // 面板就地展开在账户表格上方，不弹窗、不跳页；再点一次按钮或右上角 × 关闭。
    const locateAmountText = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : LOCATE_INITIAL_DEFAULTS.minAmount;
    };

    function closeLocateInitialPanel() {
      locateInitialState.account = null;
      locateInitialPayload = null;
      const wrap = $('initialFundLocator');
      if (wrap) wrap.innerHTML = '';
    }

    // async：关闭分支也要返回 Promise，否则调用方的 .catch 会作用在 undefined 上抛错
    async function toggleLocateInitialPanel(account) {
      if (locateInitialState.account === account) {
        closeLocateInitialPanel();
        // 按钮的 is-open 高亮跟着复位（不整表重绘，避免打断正在输入的单元格）
        document.querySelectorAll('[data-account-locate]').forEach(btn => {
          btn.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
        });
        return;
      }
      locateInitialState = {
        account,
        minAmount: LOCATE_INITIAL_DEFAULTS.minAmount,
        days: LOCATE_INITIAL_DEFAULTS.days,
      };
      document.querySelectorAll('[data-account-locate]').forEach(btn => {
        const open = btn.dataset.accountLocate === account;
        btn.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      return loadLocateInitialPanel();
    }

    async function loadLocateInitialPanel() {
      const wrap = $('initialFundLocator');
      if (!wrap || !locateInitialState.account) return;
      const account = locateInitialState.account;
      const minAmount = locateInitialState.minAmount;
      const days = locateInitialState.days;
      wrap.innerHTML = `<div class="initial-fund-locate"><p class="muted">正在查询「${esc(account)}」的大额流入…</p></div>`;
      let payload = null;
      try {
        payload = await api(`/api/initial-fund-locate?account=${encodeURIComponent(account)}`
          + `&min_amount=${encodeURIComponent(minAmount)}&days=${encodeURIComponent(days)}`);
      } catch (err) {
        // 查询失败不该炸页面：面板收掉，状态栏说明原因
        wrap.innerHTML = '';
        const status = $('status');
        if (status) status.textContent = `定位期初失败：${err.message}`;
        return;
      }
      if (locateInitialState.account !== account) return; // 查询期间用户切走了，丢弃旧结果
      renderLocateInitialPanel(payload);
    }

    function renderLocateInitialPanel(payload) {
      const wrap = $('initialFundLocator');
      if (!wrap) return;
      locateInitialPayload = payload;
      const rows = payload.candidates.map(item => `
        <tr>
          <td><input type="checkbox" data-locate-pick="${esc(item.id)}" checked></td>
          <td class="num-cell">${esc(item.entry_no)}</td>
          <td>${esc(item.transaction_time)}</td>
          <td class="money-cell">${esc(signedMoney(item.amount_cents, 'income'))}</td>
          <td>${esc(item.type)}</td>
          <td>${esc(item.transaction_object || '')}</td>
          <td>${esc(categoryLabel(item.category) || '未分类')}</td>
          <td class="locate-note">${esc(item.note || '')}</td>
        </tr>`).join('');
      const rangeOptions = [['0', '全部'], ['30', '近30天'], ['90', '近90天'], ['365', '近1年']];
      const currentDays = payload.all_history ? '0' : String(payload.days);
      const rangeText = payload.all_history
        ? `全部历史${payload.window_start ? `（${esc(payload.window_start)} 起）` : ''}`
        : `${esc(payload.window_start)} ~ ${esc(payload.window_end)} · 锚点：${esc(payload.anchor_basis || '')}`;
      wrap.innerHTML = `
        <div class="initial-fund-locate" data-locate-account="${esc(payload.account)}">
          <div class="initial-fund-locate-head">
            <strong>「${esc(payload.account)}」的大额流入 · 共 ${esc(payload.count)} 笔</strong>
            <button type="button" class="icon-button" data-locate-close aria-label="关闭">×</button>
          </div>
          <div class="initial-fund-locate-controls">
            <label>金额 ≥
              <input type="text" inputmode="decimal" data-locate-min value="${esc(locateAmountText(payload.min_amount))}" aria-label="金额阈值（元）">
            </label>
            <label>时间范围
              <select data-locate-days>
                ${rangeOptions.map(([value, label]) =>
                  `<option value="${value}" ${value === currentDays ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
            <span class="muted">单位：元 · 只看流入（收入/收款/借入）</span>
          </div>
          <p class="muted">扫描范围：${rangeText} · 单笔 ≥ ${esc(payload.min_amount)} 元 · 账户「${esc(payload.account)}」</p>
          <p class="muted">这些钱如果是本金注入（开卡后存钱 / 别人汇入），勾选后标记为「期初资金」——
            <strong>它们不再计入收入统计</strong>，但<strong>账户余额不变</strong>（钱本来就在账上）。</p>
          ${payload.count
            ? `<table class="plain-table">
                <thead><tr><th>选</th><th>编号</th><th>时间</th><th>金额</th><th>当前类型</th><th>交易对象</th><th>分类</th><th>备注</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>`
            : `<p class="muted">没有符合条件的大额流入 —— 把金额阈值调小，或把时间范围改成「全部」再看看。</p>`}
          <div class="initial-fund-locate-actions">
            <button type="button" class="secondary" data-locate-all ${payload.count ? '' : 'disabled'}>全选</button>
            <button type="button" class="secondary" data-locate-none ${payload.count ? '' : 'disabled'}>全不选</button>
            <span class="muted" data-locate-count></span>
            <button type="button" class="primary" data-locate-mark ${payload.count ? '' : 'disabled'}>标记为期初资金</button>
          </div>
        </div>`;
      const picks = () => [...wrap.querySelectorAll('[data-locate-pick]')];
      const syncCount = () => {
        const picked = picks().filter(el => el.checked);
        const cents = picked.reduce((sum, el) => sum + Number(pickedCents(el.dataset.locatePick)), 0);
        const label = wrap.querySelector('[data-locate-count]');
        if (label) label.textContent = `已选 ${picked.length} 笔，合计 ${money(cents)} 元`;
      };
      // 用 payload 里的金额算合计，避免再去 DOM 里取数字格式
      const amountById = new Map(payload.candidates.map(item => [String(item.id), item.amount_cents]));
      const pickedCents = (id) => amountById.get(String(id)) || 0;
      picks().forEach(el => { el.onchange = syncCount; });
      syncCount();
      wrap.querySelector('[data-locate-close]').onclick = closeLocateInitialPanel;
      wrap.querySelector('[data-locate-all]').onclick = () => { picks().forEach(el => { el.checked = true; }); syncCount(); };
      wrap.querySelector('[data-locate-none]').onclick = () => { picks().forEach(el => { el.checked = false; }); syncCount(); };
      const minInput = wrap.querySelector('[data-locate-min]');
      const applyMinAmount = () => {
        const raw = minInput.value;
        const parsed = Number(String(raw).replace(/[,，￥¥\s元]/g, ''));
        const valid = String(raw).trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
        locateInitialState.minAmount = valid ? locateAmountText(parsed) : LOCATE_INITIAL_DEFAULTS.minAmount;
        if (!valid) {
          minInput.value = locateInitialState.minAmount;
          const status = $('status');
          if (status) status.textContent = `金额阈值「${raw}」不是有效数字，已回退到 ${LOCATE_INITIAL_DEFAULTS.minAmount} 元`;
        }
        loadLocateInitialPanel();
      };
      minInput.onchange = applyMinAmount;
      minInput.onkeydown = event => {
        if (event.key === 'Enter') { event.preventDefault(); minInput.blur(); }
      };
      wrap.querySelector('[data-locate-days]').onchange = event => {
        locateInitialState.days = event.target.value;
        loadLocateInitialPanel();
      };
      wrap.querySelector('[data-locate-mark]').onclick = () => markLocatedInitialFund().catch(err => alert(err.message));
    }

    async function markLocatedInitialFund() {
      const wrap = $('initialFundLocator');
      const payload = locateInitialPayload;
      if (!wrap || !payload) return;
      const ids = [...wrap.querySelectorAll('[data-locate-pick]')]
        .filter(el => el.checked)
        .map(el => Number(el.dataset.locatePick));
      if (!ids.length) {
        alert('还没有勾选任何账目');
        return;
      }
      const picked = payload.candidates.filter(item => ids.includes(Number(item.id)));
      const totalCents = picked.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
      const detail = picked.map(item =>
        `  · ${item.transaction_time}  ${item.type}  ${item.amount} 元  ${item.transaction_object || ''}`
      );
      // 二次确认必须把话说死：改的是统计口径，不是钱
      const ok = confirm(
        `确认把 ${ids.length} 笔、合计 ${money(totalCents)} 元标记为「期初资金」吗？\n\n`
        + `${detail.join('\n')}\n\n`
        + `改完会怎样：\n`
        + `  · 这些账目不再计入收入统计，相应月份的收入数字会减少（合计 ${money(totalCents)} 元）；\n`
        + `  · 账户余额不会变化（钱本来就在账上，期初资金与收入同方向计入余额）；\n`
        + `  · 金额、时间、账户、交易对象都不动，只改类型（并把状态置为已确认）。\n\n`
        + `确定要标记吗？`
      );
      if (!ok) return;
      const account = payload.account;
      const result = await api('/api/initial-fund-mark', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ids})
      });
      await refresh();
      if (locateInitialState.account === account) await loadLocateInitialPanel();
      const skipped = result.skipped || [];
      const skippedText = skipped.length
        ? `；跳过 ${skipped.length} 条（${skipped.map(row => `#${row.id}: ${row.reason}`).join('、')}）`
        : '';
      const status = $('status');
      if (status) {
        status.textContent = `已把 ${result.changed_count} 笔标记为期初资金，收入统计减少 ${result.removed_income} 元，账户余额不变${skippedText}`;
      }
    }

    // 「按当前实际余额倒推期初」：期初 = 你输入的真实余额 − 这段时间的流水净额。
    // 写入后该账户的余额应当精确等于你输入的那个数（核心验收点）。
    async function saveAccountBackfill(input, name) {
      if (input.dataset.saving === 'true') return;
      const raw = input.value.trim();
      backfillAccountName = null;
      const restore = () => {
        $('assetList').innerHTML = renderAccountBalances(accountBalances);
        bindAccountActions();
      };
      if (!raw) return restore();
      const actualCents = Math.round(Number(String(raw).replace(/[,，￥¥\s]/g, '')) * 100);
      if (!Number.isFinite(actualCents)) {
        alert('请填一个数字，例如 5000 或 5000.00');
        return restore();
      }
      const row = accountBalances.find(item => item.name === name) || {};
      const netFlow = Number(row.net_flow_cents || 0);
      const initialCents = actualCents - netFlow;
      const ok = confirm(
        `账户：${name}\n`
        + `你输入的实际余额：${balanceMoney(actualCents)}\n`
        + `这段时间的流水净额：${signedFlowText(netFlow)}\n`
        + `倒推出来的期初：${balanceMoney(initialCents)}\n`
        + `（公式：期初 = 实际余额 − 流水净额）\n\n`
        + `写入后这个账户的余额会精确等于 ${balanceMoney(actualCents)}。\n`
        + `只改期初，不会产生任何账目记录。确认写入吗？`
      );
      if (!ok) return restore();
      input.dataset.saving = 'true';
      await api('/api/account-initial-balance', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name, amount: money(initialCents)})
      });
      await refresh();
    }

    // 新增账户：先建账户（/api/account-add），填了初始余额再走
    // /api/account-initial-balance —— 新账户没有流水，所以余额天然等于期初。
    async function addAccountFromAssets() {
      const name = $('newAccountName').value.trim();
      const balance = $('newAccountBalance').value.trim();
      if (!name) return;
      await api('/api/account-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name})
      });
      if (balance) {
        await api('/api/account-initial-balance', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({name, amount: balance})
        });
      }
      $('newAccountName').value = '';
      $('newAccountBalance').value = '';
      await refresh();
    }

    function bindAccountActions() {
      document.querySelectorAll('[data-account-name-edit]').forEach(btn => {
        btn.onclick = () => {
          editingAccountName = btn.dataset.accountNameEdit;
          editingAccountBalanceName = null;
          editingAccountInitialName = null;
          backfillAccountName = null;
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
          document.querySelector(`[data-account-name-input="${CSS.escape(editingAccountName)}"]`)?.focus();
        };
      });
      document.querySelectorAll('[data-account-name-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveAccountName(input, input.dataset.accountNameInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            editingAccountName = null;
            $('assetList').innerHTML = renderAccountBalances(accountBalances);
            bindAccountActions();
          }
        };
        input.onblur = () => saveAccountName(input, input.dataset.accountNameInput).catch(err => {
          alert(err.message === 'account already exists' ? '账户名已存在。' : err.message);
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
        });
      });
      document.querySelectorAll('[data-account-balance-edit]').forEach(btn => {
        btn.onclick = () => {
          editingAccountBalanceName = btn.dataset.accountBalanceEdit;
          editingAccountName = null;
          editingAccountInitialName = null;
          backfillAccountName = null;
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
          document.querySelector(`[data-account-balance-input="${CSS.escape(editingAccountBalanceName)}"]`)?.focus();
        };
      });
      document.querySelectorAll('[data-account-balance-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveAccountBalance(input, input.dataset.accountBalanceInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            editingAccountBalanceName = null;
            $('assetList').innerHTML = renderAccountBalances(accountBalances);
            bindAccountActions();
          }
        };
        input.onblur = () => saveAccountBalance(input, input.dataset.accountBalanceInput).catch(err => {
          alert(err.message);
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
        });
      });
      // 期初余额：点击铅笔 → 变输入框 → 回车/失焦保存、Esc 取消（与余额编辑同一套手感）
      document.querySelectorAll('[data-account-initial-edit]').forEach(btn => {
        btn.onclick = () => {
          editingAccountInitialName = btn.dataset.accountInitialEdit;
          editingAccountName = null;
          editingAccountBalanceName = null;
          backfillAccountName = null;
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
          document.querySelector(`[data-account-initial-input="${CSS.escape(editingAccountInitialName)}"]`)?.focus();
        };
      });
      document.querySelectorAll('[data-account-initial-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveAccountInitial(input, input.dataset.accountInitialInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            editingAccountInitialName = null;
            $('assetList').innerHTML = renderAccountBalances(accountBalances);
            bindAccountActions();
          }
        };
        input.onblur = () => saveAccountInitial(input, input.dataset.accountInitialInput).catch(err => {
          alert(err.message);
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
        });
      });
      // 「倒推」：点一下把期初列切成输入框，填银行 App 里的真实余额后回车
      document.querySelectorAll('[data-account-backfill]').forEach(btn => {
        btn.onclick = () => {
          if (btn.disabled) return;
          backfillAccountName = btn.dataset.accountBackfill;
          editingAccountName = null;
          editingAccountBalanceName = null;
          editingAccountInitialName = null;
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
          document.querySelector(`[data-account-backfill-input="${CSS.escape(backfillAccountName)}"]`)?.focus();
        };
      });
      document.querySelectorAll('[data-account-backfill-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveAccountBackfill(input, input.dataset.accountBackfillInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            backfillAccountName = null;
            $('assetList').innerHTML = renderAccountBalances(accountBalances);
            bindAccountActions();
          }
        };
        input.onblur = () => saveAccountBackfill(input, input.dataset.accountBackfillInput).catch(err => {
          alert(err.message);
          $('assetList').innerHTML = renderAccountBalances(accountBalances);
          bindAccountActions();
        });
      });
      // 「定位期初」：点一下在表格上方就地展开该账户的大额流入面板（再点一次或 × 关闭）
      document.querySelectorAll('[data-account-locate]').forEach(btn => {
        btn.onclick = () => toggleLocateInitialPanel(btn.dataset.accountLocate).catch(err => alert(err.message));
      });
      document.querySelectorAll('[data-account-delete]').forEach(btn => {
        btn.onclick = () => scheduleAccountDelete(btn.dataset.accountDelete);
      });
      if ($('addAccount')) $('addAccount').onclick = () => addAccountFromAssets().catch(err => alert(err.message));
      ['newAccountName', 'newAccountBalance'].forEach(id => {
        if ($(id)) $(id).onkeydown = event => {
          if (event.key === 'Enter') addAccountFromAssets().catch(err => alert(err.message));
        };
      });
    }

    function renderDebtBalances(rows) {
      if (!rows.length) return '<div class="muted">暂无数据</div>';
      return `<table class="debt-table">
        <thead><tr><th>交易对象</th><th>应收</th><th>应付</th><th></th></tr></thead>
        <tbody>${rows.map(row => `
          <tr>
            <td>${esc(row.name)}</td>
            <td class="money-cell debt-money">${esc(money(row.receivable_cents))}</td>
            <td class="money-cell debt-money">${esc(money(row.payable_cents))}</td>
            <td class="debt-actions"><button class="text-delete" data-debt-delete="${esc(row.id)}">删除</button></td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    }

    function bindDebtActions() {
      document.querySelectorAll('[data-debt-delete]').forEach(btn => {
        btn.onclick = () => scheduleDebtDelete(Number(btn.dataset.debtDelete));
      });
    }

    const trendHoverPoints = {};
    const pieHoverRegions = {};
    let chartAnimationToken = 0;
    let chartResizeTimer = null;

    function cssVar(name) {
      return getComputedStyle(document.body).getPropertyValue(name).trim();
    }

    function chartFont(size, weight = 500) {
      return `${weight} ${size}px "Times New Roman", Times, FangSong, STFangsong, serif`;
    }

    function prepareCanvas(canvas, cssWidth, cssHeight, displayWidth = cssWidth, displayHeight = cssHeight) {
      const ratio = window.devicePixelRatio || 1;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return {ctx, width: cssWidth, height: cssHeight};
    }

    function chartDisplaySize(canvas, square = false) {
      const wrap = canvas.parentElement;
      const width = Math.max(1, wrap.clientWidth);
      const height = Math.max(1, wrap.clientHeight);
      if (!square) return {width, height};
      const size = Math.min(width, height);
      return {width: size, height: size};
    }

    function textPill(ctx, text, x, y, align, color) {
      ctx.font = chartFont(11);
      const metrics = ctx.measureText(text);
      const width = metrics.width + 12;
      const height = 18;
      const left = align === 'right' ? x - width : x;
      roundedRect(ctx, left, y - height + 4, width, height, 5);
      ctx.fillStyle = cssVar('--panel');
      ctx.globalAlpha = .94;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.fillText(text, x + (align === 'right' ? -6 : 6), y);
    }

    function roundedRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + width, y, x + width, y + height, radius);
      ctx.arcTo(x + width, y + height, x, y + height, radius);
      ctx.arcTo(x, y + height, x, y, radius);
      ctx.arcTo(x, y, x + width, y, radius);
      ctx.closePath();
    }

    function drawSmoothLine(ctx, points) {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
          return;
        }
        const prev = points[index - 1];
        const midX = (prev.x + point.x) / 2;
        ctx.bezierCurveTo(midX, prev.y, midX, point.y, point.x, point.y);
      });
    }

    // 收支趋势：柱状（默认）/ 折线，可切换；切换时用缓存的数据直接重绘（progress=1，不重放动画）
    const TREND_SERIES = [
      {key: 'income_cents', label: '收入', tone: 'income', direction: -1},
      {key: 'expense_cents', label: '支出', tone: 'expense', direction: 1},
    ];

    function trendModeIsBar() {
      return trendChartMode !== 'line';
    }

    function syncTrendModeSwitch() {
      document.querySelectorAll('[data-trend-mode]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.trendMode === trendChartMode));
    }

    function redrawTrendChart() {
      if (!lastTrendPoints) return;
      drawTrend('cashflowTrend', lastTrendPoints, 1);
    }

    function drawTrend(canvasId, points, progress = 1) {
      lastTrendPoints = points;
      const mode = trendModeIsBar() ? 'bar' : 'line';
      const canvas = $(canvasId);
      const display = chartDisplaySize(canvas);
      const {ctx, width, height} = prepareCanvas(canvas, display.width, display.height);
      ctx.clearRect(0, 0, width, height);
      const pad = {left: 58, right: 26, top: 18, bottom: 34};
      const chartW = width - pad.left - pad.right;
      const chartH = height - pad.top - pad.bottom;
      roundedRect(ctx, 8, 8, width - 16, height - 16, 8);
      ctx.fillStyle = colorMixPanel();
      ctx.fill();
      ctx.strokeStyle = cssVar('--line');
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = pad.top + chartH * i / 4;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
      }
      if (!points.length) {
        ctx.fillStyle = cssVar('--muted');
        ctx.font = chartFont(14);
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', width / 2, height / 2);
        return;
      }
      const values = points.flatMap(p => [Number(p.income_cents || 0), Number(p.expense_cents || 0)]);
      const max = Math.max(...values, 100);
      const step = chartW / Math.max(points.length - 1, 1);
      // 柱状模式按「格」居中，折线模式沿用原来的点坐标
      const slot = chartW / Math.max(points.length, 1);
      const pointX = (index) => mode === 'bar' ? pad.left + slot * (index + .5) : pad.left + index * step;
      // 柱宽自适应：点少时有上限，点多时自然变细
      const barGroupWidth = Math.max(2, Math.min(slot * .72, 26, chartW));
      const barGap = Math.max(1, Math.min(3, slot * .12));
      const barWidth = Math.max(.8, (barGroupWidth - barGap) / 2);
      trendHoverPoints[canvasId] = [];
      const zeroY = pad.top + chartH / 2;
      ctx.strokeStyle = cssVar('--ink');
      ctx.globalAlpha = .7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(width - pad.right, zeroY);
      ctx.stroke();
      ctx.globalAlpha = 1;

      TREND_SERIES.forEach(seriesConfig => {
        const color = toneColor(seriesConfig.tone);
        const series = points.map((p, i) => {
          const value = Number(p[seriesConfig.key] || 0);
          const magnitude = (value / max) * (chartH / 2 - 12) * progress;
          return {
            x: pointX(i),
            y: zeroY + seriesConfig.direction * magnitude,
            magnitude,
            value,
            day: p.day,
            label: seriesConfig.label,
            tone: seriesConfig.tone,
          };
        });
        if (mode === 'bar') {
          ctx.fillStyle = color;
          series.forEach(point => {
            const height = point.magnitude > 0 ? Math.max(1.5, point.magnitude) : 0;
            if (!height) return;
            const left = point.x - barGroupWidth / 2 + (seriesConfig.direction < 0 ? 0 : barWidth + barGap);
            const top = seriesConfig.direction < 0 ? zeroY - height : zeroY;
            roundedRect(ctx, left, top, barWidth, height, Math.min(3, barWidth / 2));
            ctx.fill();
          });
        } else {
          drawSmoothLine(ctx, series);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        const avg = series.reduce((sum, point) => sum + point.value, 0) / Math.max(series.length, 1);
        const avgY = zeroY + seriesConfig.direction * (avg / max) * (chartH / 2 - 12) * progress;
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = color;
        ctx.globalAlpha = .58;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, avgY);
        ctx.lineTo(width - pad.right, avgY);
        ctx.stroke();
        ctx.restore();
        const labelY = avgY + (seriesConfig.direction < 0 ? -10 : 22);
        textPill(ctx, `${seriesConfig.label}日均 ${money(avg)}`, width - pad.right - 4, labelY, 'right', color);
        ctx.globalAlpha = 1;
        series.forEach(point => {
          trendHoverPoints[canvasId].push(point);
        });
      });
      ctx.font = chartFont(12);
      ctx.fillStyle = cssVar('--muted');
      ctx.textAlign = 'center';
      points.filter((_, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 5) === 0).forEach(p => {
        const index = points.indexOf(p);
        ctx.fillText(String(p.day || '').slice(5).replace('-', '/'), pointX(index), height - 16);
      });
    }

    function colorMixPanel() {
      return document.body.dataset.theme === 'dark' ? 'rgba(255,255,255,.025)' : 'rgba(255,255,255,.42)';
    }

    const pieColors = ['#0e6f5c', '#a83f2d', '#2459a6', '#8a5a16', '#6f4aa8', '#18704b', '#b45c38', '#557a2f', '#8f3f67', '#5f6f7a'];

    function drawPie(canvasId, rows, tone, progress = 1) {
      const canvas = $(canvasId);
      const display = chartDisplaySize(canvas);
      const {ctx, width, height} = prepareCanvas(canvas, display.width, display.height);
      ctx.clearRect(0, 0, width, height);
      pieHoverRegions[canvasId] = [];
      const total = rows.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
      if (!total) {
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted').trim();
        ctx.font = chartFont(14);
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', width / 2, height / 2);
        return;
      }
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.max(44, Math.min(height * .31, width * .18));
      const innerRadius = radius * .6;
      let start = -Math.PI / 2;
      const labels = [];
      rows.forEach((row, index) => {
        const value = Number(row.amount_cents || 0);
        const percent = value / total;
        const angle = percent * Math.PI * 2 * progress;
        const end = start + angle;
        if (progress > .98) {
          pieHoverRegions[canvasId].push({start, end, row, percent, tone, cx, cy, innerRadius, radius});
        }
        ctx.beginPath();
        ctx.arc(cx, cy, radius, start, end);
        ctx.arc(cx, cy, innerRadius, end, start, true);
        ctx.closePath();
        ctx.fillStyle = pieColors[index % pieColors.length];
        ctx.fill();
        const fullMid = start + (percent * Math.PI * 2) / 2;
        labels.push({
          row,
          percent,
          color: pieColors[index % pieColors.length],
          mid: fullMid,
          side: Math.cos(fullMid) >= 0 ? 'right' : 'left',
          sourceX: cx + Math.cos(fullMid) * (radius + 4),
          sourceY: cy + Math.sin(fullMid) * (radius + 4),
          elbowX: cx + Math.cos(fullMid) * (radius + 30),
          elbowY: cy + Math.sin(fullMid) * (radius + 30),
          labelY: cy + Math.sin(fullMid) * (radius + 42),
        });
        start += percent * Math.PI * 2 * progress;
      });
      ctx.fillStyle = toneColor(tone);
      ctx.font = chartFont(22, 800);
      ctx.textAlign = 'center';
      ctx.fillText(money(total * progress), cx, cy + 8);
      if (progress > .98) drawPieLabels(ctx, {width, height}, labels.filter(label => label.percent >= .035));
    }

    function distributeLabels(labels, canvasHeight) {
      const sorted = labels.slice().sort((a, b) => a.labelY - b.labelY);
      const gap = 26;
      const minY = 26;
      const maxY = canvasHeight - 26;
      sorted.forEach(label => {
        label.labelY = Math.max(minY, Math.min(maxY, label.labelY));
      });
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].labelY - sorted[i - 1].labelY < gap) {
          sorted[i].labelY = sorted[i - 1].labelY + gap;
        }
      }
      const overflow = sorted.length ? sorted.at(-1).labelY - maxY : 0;
      if (overflow > 0) {
        sorted.forEach(label => {
          label.labelY -= overflow;
        });
      }
      for (let i = sorted.length - 2; i >= 0; i -= 1) {
        if (sorted[i + 1].labelY - sorted[i].labelY < gap) {
          sorted[i].labelY = sorted[i + 1].labelY - gap;
        }
      }
      sorted.forEach(label => {
        label.labelY = Math.max(minY, Math.min(maxY, label.labelY));
      });
      return sorted;
    }

    function drawPieLabels(ctx, canvas, labels) {
      const sides = {
        left: distributeLabels(labels.filter(label => label.side === 'left'), canvas.height),
        right: distributeLabels(labels.filter(label => label.side === 'right'), canvas.height),
      };
      ctx.font = chartFont(12, 650);
      Object.entries(sides).forEach(([side, sideLabels]) => {
        const right = side === 'right';
        const labelInset = Math.min(190, Math.max(110, canvas.width * .28));
        const lineX = right ? canvas.width - labelInset : labelInset;
        const textX = right ? lineX + 8 : lineX - 8;
        sideLabels.forEach(label => {
          const name = categoryLabel(label.row.category || '未分类');
          const percent = `${(label.percent * 100).toFixed(1)}%`;
          ctx.strokeStyle = label.color;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(label.sourceX, label.sourceY);
          ctx.lineTo(label.elbowX, label.elbowY);
          ctx.lineTo(lineX, label.labelY);
          ctx.stroke();
          ctx.fillStyle = cssVar('--ink-soft');
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillText(`${name} ${percent}`, textX, label.labelY + 4);
        });
      });
    }

    function animateOverviewCharts(analysis) {
      const token = ++chartAnimationToken;
      const start = performance.now();
      const duration = 620;
      const easeOut = (t) => 1 - Math.pow(1 - t, 3);
      function frame(now) {
        if (token !== chartAnimationToken) return;
        const progress = easeOut(Math.min((now - start) / duration, 1));
        drawTrend('cashflowTrend', analysis.trend, progress);
        drawPie('expensePie', analysis.expenseCategories, 'expense', progress);
        drawPie('incomePie', analysis.incomeCategories, 'income', progress);
        if (progress < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    function bindTrendHover(canvasId, tipId) {
      const canvas = $(canvasId);
      canvas.addEventListener('mousemove', (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (canvas.width / (window.devicePixelRatio || 1)) / rect.width;
        const nearest = (trendHoverPoints[canvasId] || [])
          .map(point => ({point, distance: Math.abs(point.x - x)}))
          .sort((a, b) => a.distance - b.distance)[0];
        const tip = $(tipId);
        if (!nearest || nearest.distance > 24) {
          tip.style.display = 'none';
          return;
        }
        const sameDay = (trendHoverPoints[canvasId] || []).filter(point => point.day === nearest.point.day);
        tip.innerHTML = `<strong>${esc(nearest.point.day)}</strong>` + sameDay.map(point =>
          `${esc(point.label)}：${esc(signedMoney(point.value, point.tone))}`
        ).join('<br>');
        tip.style.left = `${event.clientX - rect.left}px`;
        tip.style.top = `${event.clientY - rect.top}px`;
        tip.style.display = 'block';
      });
      canvas.addEventListener('mouseleave', () => {
        $(tipId).style.display = 'none';
      });
    }

    bindTrendHover('cashflowTrend', 'cashflowTrendTip');

    // 收支趋势：柱状 / 折线切换（默认柱状，选择存 localStorage）
    document.querySelectorAll('[data-trend-mode]').forEach(btn => btn.onclick = () => {
      trendChartMode = btn.dataset.trendMode === 'line' ? 'line' : 'bar';
      localStorage.setItem('bookkeeping.trendChartMode', trendChartMode);
      syncTrendModeSwitch();
      redrawTrendChart();   // 只重绘图表，不重放 620ms 入场动画
    });
    syncTrendModeSwitch();

    function bindPieHover(canvasId, tipId) {
      const canvas = $(canvasId);
      canvas.addEventListener('mousemove', (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (canvas.width / (window.devicePixelRatio || 1)) / rect.width;
        const y = (event.clientY - rect.top) * (canvas.height / (window.devicePixelRatio || 1)) / rect.height;
        const regions = pieHoverRegions[canvasId] || [];
        const hit = regions.find(region => {
          const dx = x - region.cx;
          const dy = y - region.cy;
          const distance = Math.hypot(dx, dy);
          if (distance < region.innerRadius || distance > region.radius) return false;
          let angle = Math.atan2(dy, dx);
          if (angle < -Math.PI / 2) angle += Math.PI * 2;
          return angle >= region.start && angle <= region.end;
        });
        const tip = $(tipId);
        if (!hit) {
          tip.style.display = 'none';
          return;
        }
        const percent = (hit.percent * 100).toFixed(1);
        tip.innerHTML = `<strong>${esc(categoryLabel(hit.row.category || '未分类'))}</strong>${esc(signedMoney(hit.row.amount_cents, hit.tone))} · ${percent}%`;
        const wrapRect = canvas.parentElement.getBoundingClientRect();
        tip.style.left = `${event.clientX - wrapRect.left}px`;
        tip.style.top = `${event.clientY - wrapRect.top}px`;
        tip.style.display = 'block';
      });
      canvas.addEventListener('mouseleave', () => {
        $(tipId).style.display = 'none';
      });
    }

    bindPieHover('expensePie', 'expensePieTip');
    bindPieHover('incomePie', 'incomePieTip');
    window.addEventListener('resize', () => {
      clearTimeout(chartResizeTimer);
      chartResizeTimer = setTimeout(() => {
        if (summaryData) updateOverview();
      }, 120);
    });

    function initPeriodDefaults() {
      if (periodInitialized) {
        clampCycleIndex();
        return;
      }
      const days = entries.map(entryDay).filter(Boolean).sort();
      const today = ymd(new Date());
      customStart = customStart || days[0] || today;
      customEnd = customEnd || today;
      clampCycleIndex();
      periodInitialized = true;
    }

    function weekStart(date) {
      const start = new Date(date);
      const day = start.getDay() || 7;
      start.setDate(start.getDate() - day + 1);
      return start;
    }

    function buildCycles() {
      const today = new Date();
      if (cycleMode === 'quarter') {
        const currentQuarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
        const cycles = [];
        for (let i = 0; i < 40; i += 1) {
          const startDate = new Date(today.getFullYear(), currentQuarterStartMonth - i * 3, 1);
          const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 3, 0);
          const quarter = Math.floor(startDate.getMonth() / 3) + 1;
          cycles.push({label: `${startDate.getFullYear()} Q${quarter}`, start: ymd(startDate), end: ymd(endDate)});
        }
        return cycles;
      }
      if (cycleMode === 'week') {
        const cycles = [];
        const cursor = weekStart(today);
        for (let i = 0; i < 60; i += 1) {
          const start = addDays(cursor, -7 * i);
          const end = addDays(start, 6);
          cycles.push({label: `${ymd(start).replaceAll('-', '/')} - ${ymd(end).replaceAll('-', '/')}`, start: ymd(start), end: ymd(end)});
        }
        return cycles;
      }
      const cycles = [];
      for (let i = 0; i < 90; i += 1) {
        const day = ymd(addDays(today, -i));
        cycles.push({label: day.replaceAll('-', '/'), start: day, end: day});
      }
      return cycles;
    }

    function clampCycleIndex() {
      const cycles = buildCycles();
      selectedCycleIndex = Math.min(selectedCycleIndex, Math.max(cycles.length - 1, 0));
    }

    function currentRange() {
      if (periodMode === 'all') return {start: customStart, end: customEnd};
      if (periodMode === 'year') {
        const year = new Date().getFullYear() + yearOffset;
        return {start: `${year}-01-01`, end: `${year}-12-31`};
      }
      if (periodMode === 'month') {
        const now = new Date();
        const date = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const month = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
        return {start: `${month}-01`, end: ymd(new Date(date.getFullYear(), date.getMonth() + 1, 0))};
      }
      const cycles = buildCycles();
      return cycles[selectedCycleIndex] || {start: customStart, end: customEnd};
    }

    function entriesInRange(range) {
      return entries.filter(entry => {
        const day = entryDay(entry);
        return day && day >= range.start && day <= range.end;
      });
    }

    function daysInRange(range) {
      const start = parseDay(range.start);
      const end = parseDay(range.end);
      if (!start || !end || start > end) return [];
      const days = [];
      for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
        days.push(ymd(cursor));
      }
      return days;
    }

    function aggregateRange(range) {
      const scoped = entriesInRange(range);
      const reportable = scoped.filter(reportableEntry);
      const income = reportable.filter(e => increaseTypes.has(e.type)).reduce((sum, e) => sum + Number(e.amount_cents || 0), 0);
      const expense = reportable.filter(e => decreaseTypes.has(e.type)).reduce((sum, e) => sum + Number(e.amount_cents || 0), 0);
      const expenseCategoryMap = new Map();
      reportable.filter(e => decreaseTypes.has(e.type)).forEach(e => {
        const rawCategory = e.category || '未分类';
        const key = expenseCategoryLevel === 'minor' ? rawCategory : majorCategory(rawCategory);
        expenseCategoryMap.set(key, (expenseCategoryMap.get(key) || 0) + Number(e.amount_cents || 0));
      });
      const incomeCategoryMap = new Map();
      reportable.filter(e => increaseTypes.has(e.type)).forEach(e => {
        const key = e.category || '未分类';
        incomeCategoryMap.set(key, (incomeCategoryMap.get(key) || 0) + Number(e.amount_cents || 0));
      });
      const byDay = new Map(daysInRange(range).map(day => [day, {day, income_cents: 0, expense_cents: 0}]));
      reportable.forEach(e => {
        const day = entryDay(e);
        if (!day) return;
        const current = byDay.get(day) || {day, income_cents: 0, expense_cents: 0};
        if (increaseTypes.has(e.type)) current.income_cents += Number(e.amount_cents || 0);
        if (decreaseTypes.has(e.type)) current.expense_cents += Number(e.amount_cents || 0);
        byDay.set(day, current);
      });
      return {
        scoped,
        income,
        expense,
        expenseCategories: [...expenseCategoryMap.entries()].map(([category, amount_cents]) => ({category, amount_cents})).sort((a, b) => b.amount_cents - a.amount_cents),
        incomeCategories: [...incomeCategoryMap.entries()].map(([category, amount_cents]) => ({category, amount_cents})).sort((a, b) => b.amount_cents - a.amount_cents),
        trend: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      };
    }

    function updatePeriodVisibility() {
      $('moreControls').classList.toggle('hidden', periodMode !== 'more');
      $('prevCycle').classList.toggle('hidden', !['year', 'month', 'more'].includes(periodMode));
      $('nextCycle').classList.toggle('hidden', !['year', 'month', 'more'].includes(periodMode));
      document.querySelectorAll('[data-period-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.periodMode === periodMode));
      document.querySelectorAll('[data-cycle]').forEach(btn => btn.classList.toggle('active', btn.dataset.cycle === cycleMode));
    }

    // ═══════════ 首次使用引导（账本为空时才显示）═══════════
    // 别人刚下载、落在总览页时全是 0，不知道该干什么。这里给两个入口：
    // 「导入账单」跳设置页并展开导入面板，「手动记一笔」打开快速记账表单。
    // 判断依据是 summary.entries_count —— 一旦有账目，卡片自动消失。
    function renderFirstRunGuide() {
      const box = $('firstRunGuide');
      if (!box) return;
      const count = Number((summaryData || {}).entries_count || 0);
      if (count > 0) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }
      if (!box.innerHTML.trim()) {
        box.innerHTML = `
          <div class="guide-card">
            <div class="guide-head">
              <span class="guide-emoji" aria-hidden="true">👋</span>
              <h3>欢迎使用 My Economic</h3>
            </div>
            <p class="guide-desc">你的账本还是空的。可以从下面任一件事开始：</p>
            <div class="guide-actions">
              <div class="guide-action-row">
                <button class="primary" id="guideImportBtn" type="button">导入账单</button>
                <span class="muted">支持支付宝 / 微信 / 招商银行 / 邮储银行</span>
              </div>
              <div class="guide-action-row">
                <button class="secondary" id="guideQuickBtn" type="button">手动记一笔</button>
                <span class="muted">打开快速记账表单</span>
              </div>
            </div>
            <p class="guide-foot">💡 数据全部存在本机，不会上传任何地方</p>
          </div>`;
        const importBtn = $('guideImportBtn');
        if (importBtn) importBtn.onclick = () => openImportPanelFromGuide();
        const quickBtn = $('guideQuickBtn');
        if (quickBtn) quickBtn.onclick = () => openQuickFormFromGuide();
      }
      box.classList.remove('hidden');
    }

    function openImportPanelFromGuide() {
      importPanelOpen = true;
      switchView('settings').then(() => {
        renderImportPanel();
        const block = $('importBlock');
        if (block && block.scrollIntoView) block.scrollIntoView({behavior: 'smooth', block: 'center'});
        const pathInput = $('importPath');
        if (pathInput) setTimeout(() => { try { pathInput.focus({preventScroll: true}); } catch (e) {} }, 350);
      }).catch(err => { $('status').textContent = err.message; });
    }

    function openQuickFormFromGuide() {
      const form = $('quickForm');
      if (!form) return;
      form.classList.remove('hidden');       // 确保展开，而不是 toggle 掉
      if (form.scrollIntoView) form.scrollIntoView({behavior: 'smooth', block: 'center'});
      const amount = $('fAmount');
      if (amount) setTimeout(() => { try { amount.focus({preventScroll: true}); } catch (e) {} }, 350);
    }

    function updateOverview() {
      if (!summaryData) return;
      clampCycleIndex();
      updatePeriodVisibility();
      renderFirstRunGuide();
      document.querySelectorAll('[data-expense-category-level]').forEach(btn => btn.classList.toggle('active', btn.dataset.expenseCategoryLevel === expenseCategoryLevel));
      const range = currentRange();
      const analysis = aggregateRange(range);
      $('rangeStartText').textContent = slashDate(range.start);
      $('rangeEndText').textContent = slashDate(range.end);
      $('mIncome').textContent = signedMoney(analysis.income, 'income');
      $('mExpense').textContent = signedMoney(analysis.expense, 'expense');
      $('mBalance').textContent = signedMoney(analysis.income - analysis.expense, analysis.income - analysis.expense < 0 ? 'expense' : 'income');
      $('mPending').textContent = summaryData.unconfirmed_count;
      $('pendingNavBadge').textContent = summaryData.unconfirmed_count;
      $('pendingNavBadge').classList.toggle('hidden', Number(summaryData.unconfirmed_count || 0) === 0);
      animateOverviewCharts(analysis);
    }

    function activePickerValue() {
      const range = currentRange();
      return activeDateTarget === 'start' ? range.start : range.end;
    }

    function renderDatePicker() {
      const yearSelect = $('datePickerYear');
      const monthSelect = $('datePickerMonth');
      const selectedValue = activePickerValue();
      const selected = selectedValue ? parseDay(selectedValue) : new Date();
      const currentYear = new Date().getFullYear();
      const minYear = Math.min(currentYear - 10, selected.getFullYear() - 5);
      const maxYear = Math.max(currentYear + 5, selected.getFullYear() + 5);
      yearSelect.innerHTML = Array.from({length: maxYear - minYear + 1}, (_, i) => minYear + i)
        .map(year => `<option value="${year}">${year}年</option>`).join('');
      monthSelect.innerHTML = Array.from({length: 12}, (_, i) => i)
        .map(month => `<option value="${month}">${month + 1}月</option>`).join('');
      yearSelect.value = String(pickerMonth.getFullYear());
      monthSelect.value = String(pickerMonth.getMonth());

      const first = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), 1);
      const gridStart = addDays(first, -(first.getDay() || 7) + 1);
      const cells = [];
      for (let i = 0; i < 42; i += 1) {
        const day = addDays(gridStart, i);
        const value = ymd(day);
        const classes = [
          day.getMonth() !== pickerMonth.getMonth() ? 'outside' : '',
          value === selectedValue ? 'selected' : '',
        ].filter(Boolean).join(' ');
        cells.push(`<button class="${classes}" data-date="${value}">${day.getDate()}</button>`);
      }
      $('datePickerGrid').innerHTML = cells.join('');
    }

    function openDatePicker(target, trigger) {
      activeDateTarget = target;
      const value = activePickerValue();
      pickerMonth = value ? parseDay(value) : new Date();
      renderDatePicker();
      const picker = $('datePicker');
      const panelRect = $('periodPanel').getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      picker.style.left = `${Math.max(0, triggerRect.left - panelRect.left)}px`;
      picker.style.top = `${triggerRect.bottom - panelRect.top + 8}px`;
      picker.classList.remove('hidden');
    }

    function closeDatePicker() {
      $('datePicker').classList.add('hidden');
      activeDateTarget = null;
    }

    async function refresh() {
      const [summary, entryData, pending, cats, tree, accounts, accountFilters, debts, rules, settings, lists, defs] = await Promise.all([
        api('/api/summary'), api('/api/entries-all'), api('/api/unconfirmed'), api('/api/categories'), api('/api/category-tree'), api('/api/account-names'), api('/api/account-filter-names'), api('/api/account-debts'), api('/api/keyword-rules'), api('/api/settings'), api('/api/counterparty-lists'), api('/api/list-defs')
      ]);
      entries = pendingDelete ? entryData.filter(entry => Number(entry.id) !== Number(pendingDelete.row.id)) : entryData;
      const summaryAccounts = summary.account_balances || summary.accounts || [];
      accountBalances = pendingAccountDelete ? summaryAccounts.filter(row => row.name !== pendingAccountDelete.row.name) : summaryAccounts;
      // 「定位期初」面板绑着某个账户名：账户被删掉 / 改名后，别把它留成一个指向幽灵账户的空壳
      if (locateInitialState.account && !accountBalances.some(row => row.name === locateInitialState.account)) {
        closeLocateInitialPanel();
      }
      debtBalances = pendingDebtDelete ? debts.filter(row => Number(row.id) !== Number(pendingDebtDelete.row.id)) : debts;
      pendingItems = orderPendingItems(pending.map(item => ({
        ...item,
        ui_id: `${item.source || 'unconfirmed'}:${item.id}`
      })));
      categoryOptions = cats;
      categoryTree = tree;
      entryTypes = entryTypeList();
      if (entryFilters.type && !entryTypes.includes(entryFilters.type)) {
        entryFilters.type = '';
        entryFilters.category = '';
      }
      if (entryFilters.category && !categoryOptions.includes(entryFilters.category)) entryFilters.category = '';
      if (entryFilters.type && entryFilters.category && !categoriesForType(entryFilters.type).includes(entryFilters.category)) entryFilters.category = '';
      accountOptions = accounts;
      accountFilterOptions = accountFilters;
      keywordRules = rules;
      appSettings = settings || {};
      counterpartyListItems = Array.isArray(lists) ? lists : [];
      listDefs = Array.isArray(defs) ? defs : [];
      summaryData = summary;
      initPeriodDefaults();
      $('assetList').innerHTML = renderAccountBalances(accountBalances);
      $('debtList').innerHTML = renderDebtBalances(debtBalances);
      bindAccountActions();
      bindDebtActions();
      renderQuickFormOptions();
      if (!$('fTime').value) $('fTime').value = nowDatetimeLocal();
      rebuildEntryNumbers();
      renderEntryView();
      updateOverview();
      if (pendingBatchMode) renderPendingBatch(); else renderPending();
      updateUndoButton();
      renderCategoryEditor();
      bindAutoApplyToggle();
      renderSpecialLists();
    }

    function renderEntries() {
      const q = $('search').value.trim();
      const searched = q ? entries.filter(e => entryMatchesSearch(e, q, 'all')) : entries;
      const filtered = searched.filter(entryMatchesFilters);
      const pageSize = entryPageSize === 'all' ? filtered.length || 1 : Number(entryPageSize);
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      entryPage = Math.min(Math.max(1, entryPage), totalPages);
      const start = (entryPage - 1) * pageSize;
      const pageRows = filtered.slice(start, start + pageSize);
      const shownStart = filtered.length ? start + 1 : 0;
      const shownEnd = Math.min(start + pageSize, filtered.length);
      const pageSizeOptions = ['10', '20', '50', '100', '200', '500', 'all'];
      const controls = `
        <div class="entry-controls">
          <div class="muted">共 ${filtered.length} 条，当前 ${shownStart}-${shownEnd} 条${entryFilterSummary() ? ` · ${esc(entryFilterSummary())}` : ''}${q ? ` · 搜索「${esc(q)}」` : ''}</div>
          <div class="entry-pager">
            <button id="entryClearFilters" ${entryFilterSummary() ? '' : 'disabled'}>清除筛选</button>
            <label>每页
              <select id="entryPageSize">
                ${pageSizeOptions.map(value => `<option value="${value}" ${value === entryPageSize ? 'selected' : ''}>${value === 'all' ? '全部' : value}</option>`).join('')}
              </select>
            </label>
            <button class="secondary" id="entryPrev" ${entryPage <= 1 ? 'disabled' : ''}>上一页</button>
            <span>${entryPage} / ${totalPages}</span>
            <button class="secondary" id="entryNext" ${entryPage >= totalPages ? 'disabled' : ''}>下一页</button>
          </div>
        </div>`;
      const statusLabel = value => value === 'pending' ? '待确认' : '已确认';
      // 期初资金不需要分类，表格里显示「—」，不要显示成「未分类」（会被误认为漏填）
      const categoryCellLabel = (value, row) => (row && row.type === '期初资金' ? '—' : categoryLabel(value));
      const columns = [['transaction_time','时间'], ['type','类型'], ['category','分类', categoryCellLabel], ['status','状态', statusLabel], ['amount_cents','金额', signedEntryMoney, moneyClass], ['account','账户'], ['transaction_object','交易对象'], ['note','备注']];
      const headerCells = [
        dateHeaderCell(),
        headerFilterCell('type', '类型', entryTypes),
        headerFilterCell('category', '分类', entryFilterCategoryOptions()),
        '<th><div class="entry-head-filter static"><span class="entry-head-label">状态</span></div></th>',
        amountHeaderCell(),
        headerFilterCell('account', '账户', accountFilterOptions),
        '<th><div class="entry-head-filter static"><span class="entry-head-label">交易对象</span></div></th>',
        '<th><div class="entry-head-filter static"><span class="entry-head-label">备注</span></div></th>',
        '<th class="entry-actions-head"></th>',
      ];
      const header = '<table class="entry-table"><thead><tr>' + headerCells.join('') + '</tr></thead><tbody>';
      const rows = pageRows.map(row => {
        const cells = columns.map(c => {
          const value = c[2] ? c[2](row[c[0]], row) : row[c[0]];
          const classes = ['entry-cell'];
          if (c[3]) classes.push(c[3](row[c[0]], row));
          // 跨来源重复：只作为属性标记，在账户列右上角挂一个小标签。
          // 不写进备注、不影响筛选与统计。
          const isOverlapCell = c[0] === 'account' && Number(row.overlap_flag) === 1;
          if (isOverlapCell) classes.push('entry-cell-overlap');
          const overlapBadge = isOverlapCell
            ? '<span class="entry-overlap-badge" title="该条目与另一来源的流水疑似同一笔交易">重复</span>'
            : '';
          return `<td class="${esc(classes.filter(Boolean).join(' '))}" title="${esc(value)}"><span class="entry-cell-text">${esc(value)}</span>${overlapBadge}</td>`;
        }).join('');
        const editRow = editingEntryId === row.id ? `
          <tr class="entry-edit-row">
            <td colspan="${columns.length + 1}">
              <div class="entry-edit-panel" data-entry-form="${row.id}">
                <label>时间<input data-field="transaction_time" type="datetime-local" value="${esc(datetimeInputValue(row.transaction_time))}"></label>
                <label>类型<select data-field="type" data-entry-type="${row.id}">${optionsHtml(entryTypes, row.type)}</select></label>
                <label class="${row.type === '期初资金' ? 'hidden' : ''}">分类<select data-field="category" data-entry-category="${row.id}"${row.type === '期初资金' ? ' disabled' : ''}>${categoryOptionsHtml(categoriesForType(row.type), row.category, true)}</select></label>
                <label class="entry-edit-amount">金额<input data-field="amount" type="number" step="0.01" inputmode="decimal" value="${amountValue(row.amount_cents)}"></label>
                <label>账户<select data-field="account">${optionsHtml(accountOptions, row.account)}</select></label>
                <label class="entry-target-account ${row.type === '转账' ? '' : 'hidden'}" data-entry-target-wrap="${row.id}">转入账户<select data-field="target_account">${optionsHtml(accountOptions, row.target_account, true)}</select></label>
                <label>交易对象<input data-field="transaction_object" value="${esc(row.transaction_object)}"></label>
                <label class="entry-edit-note">备注<input data-field="note" value="${esc(row.note)}"></label>
                <div class="entry-edit-actions">
                  <button class="primary" data-entry-save="${row.id}">保存</button>
                  <button class="secondary" data-entry-cancel>取消</button>
                </div>
              </div>
            </td>
          </tr>` : '';
        return `
          <tr class="entry-row">
            ${cells}
            <td class="entry-actions">
              <button data-cat-edit="${row.id}">改分类</button>
              <button data-entry-edit="${row.id}">编辑</button>
              <button data-entry-delete="${row.id}">删除</button>
            </td>
          </tr>${editRow}`;
      }).join('');
      const emptyRow = `<tr><td class="entry-empty" colspan="${columns.length + 1}">暂无数据</td></tr>`;
      const body = header + (pageRows.length ? rows : emptyRow) + '</tbody></table>';
      $('entryTable').innerHTML = body + controls;
      document.querySelectorAll('[data-entry-filter]').forEach(select => select.onchange = () => {
        const field = select.dataset.entryFilter;
        entryFilters[field] = select.value;
        if (field === 'year' && !entryFilters.year) {
          entryFilters.month = '';
          entryFilters.day = '';
        }
        if (field === 'month') {
          entryFilters.day = '';
        }
        if (field === 'type') {
          const scopedCategories = entryFilterCategoryOptions();
          if (entryFilters.category && !scopedCategories.includes(entryFilters.category)) entryFilters.category = '';
        }
        if (['year', 'month', 'day'].includes(field)) {
          syncEntryDateRange();
        }
        entryPage = 1;
        renderEntries();
      });
      $('entryClearFilters').onclick = () => {
        clearEntryFilters();
        entryPage = 1;
        renderEntries();
      };
      document.querySelectorAll('[data-entry-amount]').forEach(input => input.onchange = () => {
        const field = input.dataset.entryAmount;
        const raw = String(input.value || '').trim();
        if (raw && Number.isNaN(Number(raw))) return;
        entryFilters[field] = raw;
        entryPage = 1;
        renderEntries();
      });
      $('entryPageSize').onchange = () => {
        entryPageSize = $('entryPageSize').value;
        localStorage.setItem('bookkeeping.entryPageSize', entryPageSize);
        entryPage = 1;
        renderEntries();
      };
      $('entryPrev').onclick = () => {
        entryPage -= 1;
        renderEntries();
      };
      $('entryNext').onclick = () => {
        entryPage += 1;
        renderEntries();
      };
      document.querySelectorAll('[data-entry-edit]').forEach(btn => btn.onclick = () => {
        editingEntryId = Number(btn.dataset.entryEdit);
        renderEntries();
      });
      document.querySelectorAll('[data-entry-cancel]').forEach(btn => btn.onclick = () => {
        editingEntryId = null;
        renderEntries();
      });
      document.querySelectorAll('[data-entry-delete]').forEach(btn => btn.onclick = () => scheduleEntryDelete(Number(btn.dataset.entryDelete)));
      document.querySelectorAll('[data-entry-type]').forEach(select => select.onchange = () => {
        const categorySelect = document.querySelector(`[data-entry-category="${select.dataset.entryType}"]`);
        categorySelect.innerHTML = categoryOptionsHtml(categoriesForType(select.value), '', true);
        const targetWrap = document.querySelector(`[data-entry-target-wrap="${select.dataset.entryType}"]`);
        if (targetWrap) targetWrap.classList.toggle('hidden', select.value !== '转账');
        // 期初资金（本金注入）不需要分类，也没有转入账户
        const isInitialFund = select.value === '期初资金';
        const categoryWrap = categorySelect?.closest('label');
        if (categoryWrap) categoryWrap.classList.toggle('hidden', isInitialFund);
        if (categorySelect) {
          categorySelect.disabled = isInitialFund;
          if (isInitialFund) categorySelect.value = '';
        }
      });
      document.querySelectorAll('[data-entry-save]').forEach(btn => btn.onclick = async () => {
        const id = Number(btn.dataset.entrySave);
        const form = document.querySelector(`[data-entry-form="${id}"]`);
        const payload = {id};
        form.querySelectorAll('[data-field]').forEach(input => payload[input.dataset.field] = input.value.trim());
        try {
          await api('/api/entry-update', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(payload)
          });
          editingEntryId = null;
          await refresh();
        } catch (err) {
          alert(err.message === 'not found' ? '后端接口未加载，请重启 Dashboard 后再保存。' : err.message);
        }
      });
    }

    function categoryPath(group, leaf) {
      return leaf ? `${group}/${leaf}` : group;
    }

    function categoriesForType(type) {
      const groups = categoryTree[type] || {};
      return Object.entries(groups).flatMap(([group, leaves]) => {
        if (!leaves.length) return [group];
        return leaves.map(leaf => categoryPath(group, leaf));
      });
    }

    function categoryRuleRows() {
      return entryTypes.flatMap(type => categoriesForType(type).map(category => ({type, category})));
    }

    async function saveCategoryRename(input, key) {
      if (input.dataset.saving === 'true') return;
      const [type, oldCategory] = key.split('|||');
      const newCategory = input.value.trim();
      editingCategoryKey = null;
      if (!newCategory || newCategory === oldCategory) {
        renderCategoryRules();
        return;
      }
      input.dataset.saving = 'true';
      await api('/api/category-rename', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, old_category: oldCategory, new_category: newCategory})
      });
      await refresh();
    }

    async function saveKeywordAdd(input, key) {
      if (input.dataset.saving === 'true') return;
      const [type, category] = key.split('|||');
      const keyword = input.value.trim();
      addingKeywordKey = null;
      if (!keyword) {
        renderCategoryRules();
        return;
      }
      input.dataset.saving = 'true';
      const result = await api('/api/keyword-rule-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, category, keyword})
      });
      if (result.applied_unconfirmed) {
        $('status').textContent = `已自动归类 ${result.applied_unconfirmed} 条待确认记录`;
      }
      await refresh();
    }

    function renderCategoryRules() {
      if (!$('categoryRules')) return;
      const typeValue = entryTypes.includes($('categoryRuleType').value) ? $('categoryRuleType').value : (entryTypes.includes('支出') ? '支出' : entryTypes[0]);
      $('categoryRuleType').innerHTML = optionsHtml(entryTypes, typeValue);
      if (typeValue) $('categoryRuleType').value = typeValue;
      const rows = categoryRuleRows().filter(row =>
        !pendingCategoryDelete || row.type !== pendingCategoryDelete.type || row.category !== pendingCategoryDelete.category
      );
      const firstTypeRows = new Set();
      $('categoryRules').innerHTML = rows.length ? rows.map(row => {
        const rules = keywordRules.filter(rule => rule.category === row.category && (!rule.type || rule.type === row.type));
        const key = `${row.type}|||${row.category}`;
        const isEditing = editingCategoryKey === key;
        const isAddingKeyword = addingKeywordKey === key;
        const showType = !firstTypeRows.has(row.type);
        firstTypeRows.add(row.type);
        return `
          <section class="category-rule-row">
            <div class="category-rule-main">
              <strong>${showType ? esc(row.type) : ''}</strong>
              ${isEditing
                ? `<input class="category-inline-input" value="${esc(row.category)}" aria-label="分类名称" data-category-edit-input="${esc(key)}">`
                : `<span class="category-rule-name">${esc(categoryLabel(row.category))}</span>`}
              <button type="button" class="icon-button" title="编辑分类" aria-label="编辑分类" data-category-edit="${esc(key)}">✎</button>
            </div>
            <div class="keyword-rule-chips">
              ${rules.length ? rules.map(rule => `
                <span class="keyword-rule-chip">
                  ${esc(rule.keyword)}
                  <button type="button" aria-label="删除 ${esc(rule.keyword)}" data-rule-delete="${esc(rule.id)}">×</button>
                </span>
              `).join('') : '<span class="muted">暂无关键词</span>'}
              ${isAddingKeyword
                ? `<input class="keyword-inline-input" placeholder="关键词" aria-label="新增关键词" data-keyword-add-input="${esc(key)}">`
                : `<button type="button" class="icon-button add" title="新增关键词" aria-label="新增关键词" data-keyword-add="${esc(key)}">+</button>`}
            </div>
            <button type="button" class="text-delete" data-category-delete="${esc(key)}">删除</button>
          </section>
        `;
      }).join('') : '<div class="muted">暂无分类</div>';
      document.querySelectorAll('[data-category-edit]').forEach(btn => btn.onclick = () => {
        editingCategoryKey = btn.dataset.categoryEdit;
        addingKeywordKey = null;
        renderCategoryRules();
        document.querySelector(`[data-category-edit-input="${CSS.escape(editingCategoryKey)}"]`)?.focus();
      });
      document.querySelectorAll('[data-category-edit-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveCategoryRename(input, input.dataset.categoryEditInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            editingCategoryKey = null;
            renderCategoryRules();
          }
        };
        input.onblur = () => saveCategoryRename(input, input.dataset.categoryEditInput).catch(err => {
          alert(err.message);
          renderCategoryRules();
        });
      });
      document.querySelectorAll('[data-category-delete]').forEach(btn => btn.onclick = async () => {
        const [type, category] = btn.dataset.categoryDelete.split('|||');
        scheduleCategoryDelete(type, category);
      });
      document.querySelectorAll('[data-keyword-add]').forEach(btn => btn.onclick = () => {
        addingKeywordKey = btn.dataset.keywordAdd;
        editingCategoryKey = null;
        renderCategoryRules();
        document.querySelector(`[data-keyword-add-input="${CSS.escape(addingKeywordKey)}"]`)?.focus();
      });
      document.querySelectorAll('[data-keyword-add-input]').forEach(input => {
        input.onkeydown = event => {
          if (event.key === 'Enter') saveKeywordAdd(input, input.dataset.keywordAddInput).catch(err => alert(err.message));
          if (event.key === 'Escape') {
            addingKeywordKey = null;
            renderCategoryRules();
          }
        };
        input.onblur = () => saveKeywordAdd(input, input.dataset.keywordAddInput).catch(err => {
          alert(err.message);
          renderCategoryRules();
        });
      });
      document.querySelectorAll('[data-rule-delete]').forEach(btn => btn.onclick = async () => {
        await api('/api/keyword-rule-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id: Number(btn.dataset.ruleDelete)})
        });
        keywordRules = await api('/api/keyword-rules');
        renderCategoryRules();
      });
    }

    function renderQuickFormOptions() {
      const typeValue = $('fType').value;
      $('fType').innerHTML = optionsHtml(entryTypes, typeValue || entryTypes[0]);
      if (entryTypes.includes(typeValue)) $('fType').value = typeValue;
      const accountValue = $('fAccount').value;
      $('fAccount').innerHTML = accountOptions.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('') +
        '<option value="__add_account__">+ 新增账户</option>';
      if (accountOptions.includes(accountValue)) $('fAccount').value = accountValue;
      const targetValue = $('fTargetAccount')?.value;
      if ($('fTargetAccount')) {
        $('fTargetAccount').innerHTML = accountOptions.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('') +
          '<option value="__add_account__">+ 新增账户</option>';
        if (accountOptions.includes(targetValue)) $('fTargetAccount').value = targetValue;
      }
      renderQuickCategoryOptions();
    }

    function renderQuickCategoryOptions() {
      const type = $('fType').value;
      const categoryValue = $('fCategory').value;
      const categories = categoriesForType(type);
      const isTransfer = type === '转账';
      // 期初资金 = 本金注入：计入余额、不计入收入，不需要分类，也没有转入账户
      const isInitialFund = type === '期初资金';
      const noCategory = isTransfer || isInitialFund;
      const accountLabel = $('fAccountWrap')?.firstChild;
      if (accountLabel && accountLabel.nodeType === Node.TEXT_NODE) accountLabel.textContent = isTransfer ? '转出账户' : '账户';
      document.querySelector('.quick-main-row')?.classList.toggle('is-transfer', isTransfer);
      $('fTargetAccountWrap')?.classList.toggle('hidden', type !== '转账');
      $('fCategoryWrap')?.classList.toggle('hidden', noCategory);
      $('fCategory').innerHTML = categories.map(name => `<option value="${esc(name)}">${esc(categoryLabel(name))}</option>`).join('') +
        '<option value="__add_category__">+ 新增分类</option>';
      if (categories.includes(categoryValue)) $('fCategory').value = categoryValue;
      if ($('fCategory')) {
        // 期初资金直接把分类框禁用清空：这类账目本来就不需要分类
        $('fCategory').disabled = isInitialFund;
        if (isInitialFund) $('fCategory').value = '';
      }
    }

    // ===== 待确认：自建两级分类选择器（大分类 → 小分类） =====
    function activePickerGroup(id, type) {
      const groups = categoryTree[type] || {};
      const names = Object.keys(groups);
      let active = pickerGroupState[id];
      if (!names.includes(active)) active = names[0] || '';
      pickerGroupState[id] = active;
      return active;
    }

    function renderPickerRows(id, type) {
      const groups = categoryTree[type] || {};
      const names = Object.keys(groups);
      const active = activePickerGroup(id, type);
      const groupChips = names.map(name => {
        const leaves = groups[name] || [];
        const badge = leaves.length
          ? `<span class="picker-count">${leaves.length}</span>`
          : '<span class="picker-count is-direct">直选</span>';
        return `<button type="button" class="chip picker-group${name === active ? ' is-active' : ''}" data-picker-group="${esc(id)}" data-picker-type="${esc(type)}" data-picker-value="${esc(name)}">${esc(name)}${badge}</button>`;
      }).join('');
      const leaves = active ? (groups[active] || []) : [];
      const leafChips = leaves.map(leaf =>
        `<button type="button" class="chip picker-leaf" data-confirm-id="${esc(id)}" data-category="${esc(categoryPath(active, leaf))}">${esc(leaf)}</button>`
      ).join('');
      const emptyHint = active
        ? `<button type="button" class="chip picker-leaf picker-direct" data-confirm-id="${esc(id)}" data-category="${esc(active)}">直接用「${esc(active)}」</button><span class="muted">该大分类下暂无小分类</span>`
        : '<span class="muted">还没有分类，先新建一个大分类</span>';
      return `
        <div class="category-group">
          <div class="category-group-title">大分类</div>
          <div class="category-group-options">
            ${groupChips}
            <button type="button" class="chip picker-add" data-picker-add-group="${esc(type)}" data-picker-id="${esc(id)}">＋ 新建大分类</button>
          </div>
        </div>
        <div class="category-group">
          <div class="category-group-title">小分类${active ? ` · ${esc(active)}` : ''}</div>
          <div class="category-group-options">
            ${leaves.length ? leafChips : emptyHint}
            ${active ? `<button type="button" class="chip picker-add" data-picker-add-leaf="${esc(active)}" data-picker-add-type="${esc(type)}" data-picker-id="${esc(id)}">＋ 新建小分类</button>` : ''}
          </div>
        </div>`;
    }

    function categoryPicker(id, type) {
      return `<div class="category-picker" id="picker-${esc(id)}">${renderPickerRows(id, type)}</div>`;
    }

    async function addPickerCategory(type, parent, kind, stateId) {
      const raw = prompt(kind === 'group' ? `在「${type}」下新建大分类` : `在「${parent}」下新建小分类`);
      if (raw === null) return;
      const name = cleanCategoryName(raw);
      if (!name) return;
      const category = kind === 'group' ? name : `${parent}/${name}`;
      await api('/api/category-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, category})
      });
      if (stateId) pickerGroupState[stateId] = kind === 'group' ? name : parent;
      await refresh();
      $('status').textContent = `已新增分类：${categoryLabel(category)}`;
    }

    // ===== 修改分类：账户页里的分类树编辑器 =====
    function categoryEditorType() {
      const saved = localStorage.getItem('bookkeeping.categoryEditorType');
      if (entryTypes.includes(saved)) return saved;
      return entryTypes.includes('支出') ? '支出' : (entryTypes[0] || '');
    }

    function categoryEditorHtml(type) {
      const groups = categoryTree[type] || {};
      const names = Object.keys(groups);
      if (!names.length) return '<div class="muted">这个类型下还没有分类。先在下面新建一个大分类，再在它下面加小分类。</div>';
      return names.map(group => {
        const leaves = groups[group] || [];
        const rows = leaves.map(leaf => `
          <span class="category-editor-leaf">
            <span class="category-editor-leaf-name">${esc(leaf)}</span>
            <button type="button" class="icon-button" title="重命名" data-cat-rename-leaf="${esc(group)}/${esc(leaf)}">✎</button>
            <button type="button" class="text-delete" title="删除" data-cat-delete-leaf="${esc(group)}/${esc(leaf)}">×</button>
          </span>`).join('');
        return `
          <section class="category-editor-group">
            <div class="category-editor-head">
              <strong>${esc(group)}</strong>
              <span class="muted">${leaves.length ? `${leaves.length} 个小分类` : '直接作为分类使用'}</span>
              <div class="category-editor-actions">
                <button type="button" class="icon-button add" title="新建小分类" data-cat-add-leaf="${esc(group)}">＋</button>
                <button type="button" class="icon-button" title="重命名大分类" data-cat-rename="${esc(group)}">✎</button>
                <button type="button" class="text-delete" title="删除大分类" data-cat-delete="${esc(group)}">删除</button>
              </div>
            </div>
            <div class="category-editor-leaves">${rows || '<span class="muted">（没有小分类）</span>'}</div>
          </section>`;
      }).join('');
    }

    function bindCategoryEditor(wrap, type) {
      if (!wrap) return;
      wrap.querySelectorAll('[data-cat-add-leaf]').forEach(btn => btn.onclick = () => {
        addEditorCategory(type, btn.dataset.catAddLeaf).catch(err => $('status').textContent = err.message);
      });
      wrap.querySelectorAll('[data-cat-rename]').forEach(btn => btn.onclick = () => {
        renameEditorCategory(type, btn.dataset.catRename).catch(err => $('status').textContent = err.message);
      });
      wrap.querySelectorAll('[data-cat-rename-leaf]').forEach(btn => btn.onclick = () => {
        renameEditorCategory(type, btn.dataset.catRenameLeaf).catch(err => $('status').textContent = err.message);
      });
      wrap.querySelectorAll('[data-cat-delete]').forEach(btn => btn.onclick = () => {
        deleteEditorCategory(type, btn.dataset.catDelete).catch(err => $('status').textContent = err.message);
      });
      wrap.querySelectorAll('[data-cat-delete-leaf]').forEach(btn => btn.onclick = () => {
        deleteEditorCategory(type, btn.dataset.catDeleteLeaf).catch(err => $('status').textContent = err.message);
      });
    }

    function renderCategoryEditor() {
      const wrap = $('categoryEditor');
      if (!wrap) return;
      const type = categoryEditorType();
      $('categoryEditorTypes').innerHTML = entryTypes.map(name =>
        `<button type="button" class="${name === type ? 'active' : ''}" data-category-editor-type="${esc(name)}">${esc(name)}</button>`
      ).join('');
      $('categoryEditorTypes').querySelectorAll('[data-category-editor-type]').forEach(btn => btn.onclick = () => {
        localStorage.setItem('bookkeeping.categoryEditorType', btn.dataset.categoryEditorType);
        renderCategoryEditor();
      });
      wrap.innerHTML = categoryEditorHtml(type);
      bindCategoryEditor(wrap, type);
    }

    async function addEditorCategory(type, parent) {
      const raw = prompt(`在「${parent}」下新建小分类`);
      if (raw === null) return;
      const leaf = cleanCategoryName(raw);
      if (!leaf) return;
      await api('/api/category-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, category: `${parent}/${leaf}`})
      });
      await refresh();
      $('status').textContent = `已新增：${parent} · ${leaf}`;
    }

    async function renameEditorCategory(type, category) {
      const raw = prompt('重命名分类', categoryLabel(category));
      if (raw === null) return;
      const next = cleanCategoryName(raw);
      if (!next || next === category) return;
      const newCategory = category.includes('/') ? `${category.split('/')[0]}/${next}` : next;
      await api('/api/category-rename', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, old_category: category, new_category: newCategory})
      });
      await refresh();
      $('status').textContent = `已重命名：${categoryLabel(category)} → ${categoryLabel(newCategory)}`;
    }

    async function deleteEditorCategory(type, category) {
      const isMajor = !category.includes('/');
      const prefix = `${category}/`;
      const affected = entries.filter(entry => entry.type === type
        && (entry.category === category || String(entry.category || '').startsWith(prefix))).length;
      const childCount = isMajor ? (categoryTree[type]?.[category] || []).length : 0;
      const message = isMajor
        ? `删除大分类「${category}」？\n\n它下面的 ${childCount} 个小分类会一起删除。\n受影响的 ${affected} 条账目会变成「未分类」，退回待确认。\n\n此操作不可撤销，确定吗？`
        : `删除小分类「${categoryLabel(category)}」？\n\n受影响的 ${affected} 条账目会变成「未分类」，退回待确认。\n\n此操作不可撤销，确定吗？`;
      if (!confirm(message)) return;
      await api('/api/category-delete', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type, category})
      });
      await refresh();
      $('status').textContent = `已删除分类：${categoryLabel(category)}${affected ? `，${affected} 条账目退回待确认` : ''}`;
    }

    function renderPendingSummary() {
      const counts = pendingItems.reduce((acc, item) => {
        const key = item.type || '未知';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      $('pendingSummary').innerHTML = rows.length ? rows.map(([name, count]) =>
        `<div class="side-item"><span>${esc(name)}</span><strong>${count}</strong></div>`
      ).join('') : '<div class="muted">没有待确认条目</div>';
    }

    function renderPending() {
      renderPendingSummary();
      if (!pendingItems.length) {
        $('pendingList').innerHTML = '<div class="section muted">没有待确认条目</div>';
        return;
      }
      const visibleItems = pendingItems.slice(0, 4);
      $('pendingList').innerHTML = visibleItems.map((item, index) => {
        const tone = moneyTone(item);
        const id = item.ui_id || item.id;
        return `
          <article class="pending-row pending-card ${index === 0 ? 'is-front' : ''}" data-id="${esc(id)}" style="--i:${index}">
            <section>
              <div class="pending-title">
                <span class="badge">${esc(item.type || '未知')}</span>
                <span class="amount ${tone === 'income' ? 'income' : tone === 'expense' ? 'expense' : 'neutral-money'}">${signedMoney(item.amount_cents, tone)}</span>
              </div>
              <div class="detail-grid">
                <div><span>时间</span>${esc(item.transaction_time)}</div>
                <div><span>账户</span>${esc(item.account)}</div>
                <div><span>转入账户</span>${esc(item.target_account || '')}</div>
                <div><span>参与人</span>${esc(item.participant || '')}</div>
                <label class="pending-object-field">
                  <span>交易对象</span>
                  <input data-confirm-object="${esc(id)}" value="${esc(item.transaction_object || '')}" placeholder="对方名称、债务人或平台">
                </label>
                <label class="pending-object-field">
                  <span>备注</span>
                  <textarea data-confirm-note="${esc(id)}" rows="3" placeholder="补充说明">${esc(item.note || '')}</textarea>
                </label>
              </div>
            </section>
            <section>
              ${categoryPicker(id, item.type)}
              <div class="confirm-line">
                <select id="cat-${id}">${categoryOptionsHtml(categoriesForType(item.type), item.category, false)}</select>
                <button class="secondary" data-pending-skip="${esc(id)}">跳过</button>
                <button class="primary" data-confirm-id="${esc(id)}">确认</button>
              </div>
            </section>
          </article>`;
      }).join('');
    }

    async function confirmWithCategory(id, category) {
      if (pendingAnimating) return;
      pendingAnimating = true;
      try {
        const objectInput = document.querySelector(`[data-confirm-object="${CSS.escape(String(id))}"]`);
        const noteInput = document.querySelector(`[data-confirm-note="${CSS.escape(String(id))}"]`);
        const item = pendingItems.find(item => String(item.ui_id || item.id) === String(id));
        await api('/api/confirm', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            id: item ? item.id : id,
            source: item?.source,
            category,
            transaction_object: objectInput ? objectInput.value.trim() : '',
            note: noteInput ? noteInput.value.trim() : '',
            learn: false
          })
        });
        pushPendingHistory(item, category);
        const card = document.querySelector(`.pending-card[data-id="${CSS.escape(String(id))}"]`);
        if (card) {
          card.classList.add('is-leaving');
          await new Promise(resolve => setTimeout(resolve, 260));
        }
        await refresh();
      } finally {
        pendingAnimating = false;
      }
    }

    async function confirmPending(id) {
      const category = $(`cat-${id}`).value.trim();
      if (!category) return;
      await confirmWithCategory(id, category);
    }

    function skipPending(id) {
      if (pendingAnimating) return;
      const index = pendingItems.findIndex(item => String(item.ui_id || item.id) === String(id));
      if (index < 0 || pendingItems.length < 2) return;
      pendingSkippedIds = pendingSkippedIds.filter(itemId => String(itemId) !== String(id));
      pendingSkippedIds.push(String(id));
      savePendingSkippedIds();
      const [item] = pendingItems.splice(index, 1);
      pendingItems.push(item);
      renderPending();
    }

    window.confirmPending = confirmPending;
    window.confirmWithCategory = confirmWithCategory;

    $('pendingList').addEventListener('click', (event) => {
      const pickerBtn = event.target.closest('[data-picker-group]');
      if (pickerBtn) {
        pickerGroupState[pickerBtn.dataset.pickerGroup] = pickerBtn.dataset.pickerValue;
        const wrap = $(`picker-${pickerBtn.dataset.pickerGroup}`);
        if (wrap) wrap.innerHTML = renderPickerRows(pickerBtn.dataset.pickerGroup, pickerBtn.dataset.pickerType);
        return;
      }
      const addGroup = event.target.closest('[data-picker-add-group]');
      if (addGroup) {
        addPickerCategory(addGroup.dataset.pickerAddGroup, '', 'group', addGroup.dataset.pickerId).catch(err => $('status').textContent = err.message);
        return;
      }
      const addLeaf = event.target.closest('[data-picker-add-leaf]');
      if (addLeaf) {
        addPickerCategory(addLeaf.dataset.pickerAddType, addLeaf.dataset.pickerAddLeaf, 'leaf', addLeaf.dataset.pickerId).catch(err => $('status').textContent = err.message);
        return;
      }
      const skip = event.target.closest('[data-pending-skip]');
      if (skip) {
        skipPending(skip.dataset.pendingSkip);
        return;
      }
      const target = event.target.closest('[data-confirm-id]');
      if (!target) return;
      const id = target.dataset.confirmId;
      const category = target.dataset.category || $(`cat-${id}`)?.value.trim();
      if (!category) return;
      confirmWithCategory(id, category).catch(err => $('status').textContent = err.message);
    });

    const titles = {home: '财务总览', entries: '账单', confirm: '待确认分类', assets: '账户', settings: '设置'};

    // 待确认视图内部的子视图：pending = 原有待确认内容，quality = 待质量审核占位面板
    // 注意：本占位面板不包含任何数据质量扫描逻辑，只做入口与切换。
    let confirmSubMode = 'pending';
    function setConfirmSubMode(mode) {
      confirmSubMode = mode === 'quality' ? 'quality' : 'pending';
      const isQuality = confirmSubMode === 'quality';
      if ($('confirmModeTabs')) {
        $('confirmModeTabs').querySelectorAll('button').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.confirmMode === confirmSubMode);
        });
      }
      if ($('confirm')) $('confirm').classList.toggle('is-quality', isQuality);
      if ($('qualityPanel')) $('qualityPanel').classList.toggle('hidden', !isQuality);
      const aside = document.querySelector('#confirm > aside');
      if (aside) aside.classList.toggle('hidden', isQuality);
      if ($('pendingBatch')) $('pendingBatch').classList.toggle('hidden', isQuality || !pendingBatchMode);
      if ($('pendingList')) $('pendingList').classList.toggle('hidden', isQuality || pendingBatchMode);
      if (isQuality) renderQualityPanel();
    }

    // 待质量审核：本地只读扫描（GET /api/quality-scan）。
    // 进入面板不自动扫描——只有点「开始扫描」才发请求；扫描结果只展示，不提供任何修改数据的入口。
    const QUALITY_RULE_LABELS = {
      transfer_as_income: '内部划转被当收入',
      duplicate: '疑似重复',
      orphan_category: '孤儿分类',
      outlier_amount: '异常大额'
    };
    const QUALITY_RULE_ORDER = ['transfer_as_income', 'duplicate', 'orphan_category', 'outlier_amount'];
    let qualityScan = {state: 'idle', data: null, error: ''};

    function qualityGroups() {
      const groups = QUALITY_RULE_ORDER.map(rule => ({rule, label: QUALITY_RULE_LABELS[rule], items: []}));
      ((qualityScan.data && qualityScan.data.items) || []).forEach(item => {
        const group = groups.find(g => g.rule === item.rule);
        if (group) group.items.push(item);
      });
      return groups;
    }

    function renderQualitySummary() {
      const summary = (qualityScan.data && qualityScan.data.summary) || {};
      return `<div class="quality-summary">${QUALITY_RULE_ORDER.map(rule => `
        <span class="tag-chip">${esc(QUALITY_RULE_LABELS[rule])}<span class="tag-count">${Number(summary[rule] || 0)}</span></span>
      `).join('')}</div>`;
    }

    function renderQualityItem(item) {
      const severityText = {high: '高风险', medium: '中等', low: '提示'}[item.severity] || item.severity;
      const extra = item.median_cents == null ? '' : `
        <div class="quality-meta"><span>该分类中位数：${money(item.median_cents)} 元</span><span>离群阈值：${money(item.threshold_cents)} 元</span></div>`;
      return `
        <li class="quality-item severity-${esc(item.severity || 'low')}">
          <div class="quality-item-head">
            <span class="quality-no">编号 ${esc(item.entry_no ?? '')}</span>
            <span>${esc(item.transaction_time || '')}</span>
            <span class="quality-amount">${money(item.amount_cents)} 元</span>
            <span class="quality-sev">${esc(severityText)}</span>
            ${item.confidence === 'low' ? '<span class="quality-weak">低可信</span>' : ''}
          </div>
          <div class="quality-meta">
            <span>类型：${esc(item.type || '—')}</span>
            <span>账户：${esc(item.account || '—')}</span>
            <span>交易对象：${esc(item.transaction_object || '—')}</span>
            <span>分类：${esc(item.category || '未分类')}</span>
          </div>
          ${extra}
          <div class="quality-reason">理由：${esc(item.reason || '')}</div>
          <div class="quality-suggestion">建议：${esc(item.suggestion || '')}</div>
        </li>`;
    }

    function renderQualityPanel() {
      const box = $('qualityResult');
      const btn = $('qualityScanBtn');
      if (!box) return;
      if (btn) {
        btn.disabled = qualityScan.state === 'loading';
        btn.textContent = qualityScan.state === 'done' || qualityScan.state === 'error' ? '重新扫描' : '开始扫描';
      }
      if (qualityScan.state === 'loading') {
        box.innerHTML = '<p class="muted">扫描中…</p>';
        return;
      }
      if (qualityScan.state === 'error') {
        box.innerHTML = `<p class="quality-error">扫描失败：${esc(qualityScan.error || '未知错误')}</p>`;
        return;
      }
      if (qualityScan.state !== 'done') {
        box.innerHTML = '<p class="muted">点上面的「开始扫描」运行本地只读体检。</p>';
        return;
      }
      const data = qualityScan.data || {};
      const groups = qualityGroups();
      const total = (data.items || []).length;
      const head = `${renderQualitySummary()}
        <p class="quality-scanned">扫描时间 ${esc(data.generated_at || '')}，共检查 ${Number(data.entry_count || 0)} 条账目，命中 ${total} 条。</p>`;
      if (!total) {
        box.innerHTML = `${head}<div class="quality-empty">没有发现问题：四项规则都没有命中，账目数据是干净的。</div>`;
        return;
      }
      const body = groups.filter(group => group.items.length).map(group => `
        <div class="quality-group">
          <div class="quality-group-head">
            <h4>${esc(group.label)}</h4><span class="tag-count">${group.items.length}</span>
          </div>
          <ul class="quality-items">${group.items.map(renderQualityItem).join('')}</ul>
        </div>
      `).join('');
      const zeroNote = groups.filter(group => !group.items.length).map(group => group.label).join(' / ');
      box.innerHTML = `${head}${body}${zeroNote ? `<p class="muted">未命中：${esc(zeroNote)}</p>` : ''}`;
    }

    async function runQualityScan() {
      if (qualityScan.state === 'loading') return;
      qualityScan = {state: 'loading', data: qualityScan.data, error: ''};
      renderQualityPanel();
      $('status').textContent = '扫描中…';
      try {
        const data = await api('/api/quality-scan');
        qualityScan = {state: 'done', data, error: ''};
        const total = (data.items || []).length;
        $('status').textContent = `质量扫描完成：${data.entry_count || 0} 条账目命中 ${total} 条问题（${data.generated_at || ''}）`;
      } catch (err) {
        qualityScan = {state: 'error', data: null, error: err.message};
        $('status').textContent = `扫描失败：${err.message}`;
      }
      renderQualityPanel();
    }
    if ($('qualityScanBtn')) $('qualityScanBtn').onclick = () => { runQualityScan(); };

    async function switchView(view) {
      await commitPendingDeletes({refreshAfter: true});
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`nav button[data-view="${view}"]`);
      if (!btn) return;
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      $(view).classList.remove('hidden');
      $('pageTitle').textContent = titles[view] || '账簿';
      $('pageTitle').dataset.view = view;
      $('periodPanel').classList.toggle('hidden', view !== 'home');
      if (view === 'entries') renderEntryView();
      if (view === 'settings') {
        reloadListDefs().then(renderSpecialLists).catch(err => $('status').textContent = err.message);
        // 折叠态以状态变量为准，切页时同步一次（默认仍是收起）
        renderCategoryHub();
        renderImportPanel();
      }
      if ($('confirmModeTabs')) $('confirmModeTabs').classList.toggle('hidden', view !== 'confirm');
      if (view === 'confirm') {
        setConfirmSubMode('pending');
        if (pendingBatchMode) renderPendingBatch(); else renderPending();
      }
    }
    document.querySelectorAll('nav button').forEach(btn => btn.onclick = () => switchView(btn.dataset.view).catch(err => alert(err.message)));

    if ($('confirmModeTabs')) {
      $('confirmModeTabs').addEventListener('click', (event) => {
        const btn = event.target.closest('[data-confirm-mode]');
        if (!btn) return;
        setConfirmSubMode(btn.dataset.confirmMode);
        if (pendingBatchMode) renderPendingBatch(); else renderPending();
      });
    }
    if ($('qualityBackBtn')) $('qualityBackBtn').onclick = () => {
      setConfirmSubMode('pending');
      if (pendingBatchMode) renderPendingBatch(); else renderPending();
    };

    window.addEventListener('pagehide', () => {
      commitPendingDeletes({keepalive: true, silent: true});
    });

    function jumpToEntriesByTone(tone) {
      const range = currentRange();
      entryFilters = {year: '', month: '', day: '', type: '', category: '', account: '', transaction_object: '', tone, start: range.start, end: range.end};
      entryPage = 1;
      switchView('entries');
    }
    $('incomeKpi').onclick = () => jumpToEntriesByTone('income');
    $('expenseKpi').onclick = () => jumpToEntriesByTone('expense');
    function setExpenseCategoryLevel(level) {
      expenseCategoryLevel = level;
      localStorage.setItem('bookkeeping.expenseCategoryLevel', expenseCategoryLevel);
      updateOverview();
    }
    document.querySelector('.level-switch')?.addEventListener('click', event => {
      event.preventDefault();
      setExpenseCategoryLevel(expenseCategoryLevel === 'major' ? 'minor' : 'major');
    });

    document.querySelectorAll('[data-period-mode]').forEach(btn => btn.onclick = () => {
      periodMode = btn.dataset.periodMode;
      if (periodMode === 'year') yearOffset = 0;
      if (periodMode === 'month') monthOffset = 0;
      if (periodMode === 'more') selectedCycleIndex = 0;
      updateOverview();
    });
    $('rangeStartTrigger').onclick = (event) => openDatePicker('start', event.currentTarget);
    $('rangeEndTrigger').onclick = (event) => openDatePicker('end', event.currentTarget);
    $('datePickerYear').onchange = () => {
      pickerMonth = new Date(Number($('datePickerYear').value), pickerMonth.getMonth(), 1);
      renderDatePicker();
    };
    $('datePickerMonth').onchange = () => {
      pickerMonth = new Date(pickerMonth.getFullYear(), Number($('datePickerMonth').value), 1);
      renderDatePicker();
    };
    $('datePickerGrid').onclick = (event) => {
      const target = event.target.closest('[data-date]');
      if (!target || !activeDateTarget) return;
      const range = currentRange();
      customStart = activeDateTarget === 'start' ? target.dataset.date : range.start;
      customEnd = activeDateTarget === 'end' ? target.dataset.date : range.end;
      if (customStart && customEnd && customStart > customEnd) {
        [customStart, customEnd] = [customEnd, customStart];
      }
      periodMode = 'all';
      closeDatePicker();
      updateOverview();
    };
    document.addEventListener('click', (event) => {
      if ($('datePicker').classList.contains('hidden')) return;
      if (event.target.closest('#datePicker') || event.target.closest('.date-trigger')) return;
      closeDatePicker();
    });
    document.querySelectorAll('[data-cycle]').forEach(btn => btn.onclick = () => {
      cycleMode = btn.dataset.cycle;
      selectedCycleIndex = 0;
      updateOverview();
    });
    $('prevCycle').onclick = () => {
      if (periodMode === 'year') yearOffset -= 1;
      else if (periodMode === 'month') monthOffset -= 1;
      else selectedCycleIndex += 1;
      updateOverview();
    };
    $('nextCycle').onclick = () => {
      if (periodMode === 'year') yearOffset += 1;
      else if (periodMode === 'month') monthOffset += 1;
      else selectedCycleIndex = Math.max(0, selectedCycleIndex - 1);
      updateOverview();
    };

    $('quickAdd').onclick = () => $('quickForm').classList.toggle('hidden');
    $('toggleQuickMore').onclick = () => {
      const panel = $('quickMoreFields');
      const expanded = panel.classList.toggle('hidden') === false;
      $('toggleQuickMore').textContent = expanded ? '收起' : '展开';
    };
    function applyTheme(dark) {
      document.body.dataset.theme = dark ? 'dark' : '';
      $('themeToggle').checked = dark;
      localStorage.setItem('bookkeeping.theme', dark ? 'dark' : 'light');
      if (summaryData) updateOverview();
    }
    function applyColorMode(inverted) {
      document.body.dataset.colorInverted = inverted ? 'true' : '';
      $('colorInvert').checked = inverted;
      localStorage.setItem('bookkeeping.colorInverted', inverted ? 'true' : 'false');
      if (summaryData) updateOverview();
    }
    $('themeToggle').onchange = () => applyTheme($('themeToggle').checked);
    $('colorInvert').onchange = () => applyColorMode($('colorInvert').checked);
    if ($('addMajorCategory')) {
      $('addMajorCategory').onclick = async () => {
        const input = $('newMajorCategory');
        const name = cleanCategoryName(input.value);
        if (!name) return;
        await api('/api/category-add', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({type: categoryEditorType(), category: name})
        });
        input.value = '';
        await refresh();
        $('status').textContent = `已新增大分类：${name}`;
      };
    }
    applyTheme(localStorage.getItem('bookkeeping.theme') === 'dark');
    applyColorMode(localStorage.getItem('bookkeeping.colorInverted') === 'true');
    $('search').oninput = () => {
      entryPage = 1;
      renderEntries();
    };
    $('fType').onchange = renderQuickCategoryOptions;
    async function addAccountFromQuick(selectId) {
      const select = $(selectId);
      if (select.value !== '__add_account__') return;
      const name = prompt('新增账户名称');
      if (!name || !name.trim()) {
        renderQuickFormOptions();
        return;
      }
      await api('/api/account-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name: name.trim()})
      });
      accountOptions = await api('/api/account-names');
      renderQuickFormOptions();
      select.value = name.trim();
    }

    $('fAccount').onchange = async () => {
      await addAccountFromQuick('fAccount');
    };
    $('fTargetAccount').onchange = async () => {
      await addAccountFromQuick('fTargetAccount');
    };
    $('fCategory').onchange = async () => {
      if ($('fCategory').value !== '__add_category__') return;
      const category = prompt($('fType').value === '支出' ? '新增分类，格式：一级/二级' : '新增分类名称');
      if (!category || !category.trim()) {
        renderQuickCategoryOptions();
        return;
      }
      await api('/api/category-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({type: $('fType').value, category: category.trim()})
      });
      [categoryOptions, categoryTree] = await Promise.all([api('/api/categories'), api('/api/category-tree')]);
      entryTypes = entryTypeList();
      renderQuickCategoryOptions();
      $('fCategory').value = category.trim();
    };
    $('saveEntry').onclick = async () => {
      const entryType = $('fType').value;
      const isTransfer = entryType === '转账';
      const isInitialFund = entryType === '期初资金';
      if ($('fAccount').value === '__add_account__' || (isTransfer && $('fTargetAccount').value === '__add_account__') || (!isTransfer && !isInitialFund && $('fCategory').value === '__add_category__')) return;
      if (isInitialFund && !$('fAccount').value) {
        alert('期初资金必须选一个账户');
        return;
      }
      await api('/api/add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          type: entryType,
          amount: $('fAmount').value,
          transaction_time: $('fTime').value ? $('fTime').value.replace('T', ' ') : '',
          account: $('fAccount').value,
          target_account: isTransfer ? $('fTargetAccount').value : '',
          // 期初资金不需要分类，传空字符串让后端保持 null
          category: isTransfer ? '转账' : (isInitialFund ? '' : $('fCategory').value),
          transaction_object: $('fTransactionObject').value.trim(),
          participant: '自己',
          note: $('fNote').value.trim(),
          learn: $('fLearn').checked
        })
      });
      $('fAmount').value = '';
      $('fTransactionObject').value = '';
      $('fNote').value = '';
      $('fTime').value = nowDatetimeLocal();
      refresh();
    };

    // ═══════════ 账本编号：最老 = 1，越新编号越大（像纸质账本） ═══════════
    function rebuildEntryNumbers() {
      const sorted = [...entries].sort((a, b) => {
        const ta = String(a.transaction_time || '');
        const tb = String(b.transaction_time || '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      });
      entryNumberMap = {};
      sorted.forEach((row, index) => { entryNumberMap[Number(row.id)] = index + 1; });
    }

    function entryNumber(row) {
      return entryNumberMap[Number(row.id)] || '';
    }

    function isInternalTransfer(row) {
      return row.type === '转账' || row.category === '转账';
    }

    function isIncomeRow(row) {
      return ['收入', '收款', '借入'].includes(row.type);
    }

    function listDefByKey(key) {
      return listDefs.find(def => def && def.key === key) || null;
    }

    function listLabelOf(key) {
      const def = listDefByKey(key);
      if (def) return def.label;
      if (key === 'whitelist') return '白名单';
      if (key === 'large') return '大额名单';
      return String(key || '名单');
    }

    function readOnlyEntryTable(rows, options = {}) {
      const showObject = options.showObject !== false;
      const showCategory = options.showCategory !== false;
      // 单条加入名单：按传进来的 kind 顺序并排渲染，每个 kind 一列
      const listAddKinds = (options.listAddKinds || []).filter(kind => listDefByKey(kind));
      const cols = 3 + (showObject ? 1 : 0) + (showCategory ? 1 : 0) + 1 + listAddKinds.length + 1;
      const listIdSets = new Map(listAddKinds.map(kind => [kind, entryIdSet(kind)]));
      const body = rows.map(row => `
        <tr>
          <td class="num-cell">${entryNumber(row)}</td>
          <td>${esc(row.transaction_time || '')}</td>
          <td class="money-cell">${esc(signedEntryMoney(row.amount_cents, row))}</td>
          ${showObject ? `<td>${esc(row.transaction_object || '')}</td>` : ''}
          ${showCategory ? `<td>${esc(categoryLabel(row.category) || '未分类')}</td>` : ''}
          <td>${esc(row.note || '')}</td>
          ${listAddKinds.map(kind => `<td class="list-add-cell">${listIdSets.get(kind).has(Number(row.id))
            ? '<span class="muted">已在</span>'
            : `<button type="button" class="icon-button add" data-add-list="${esc(kind)}" data-add-entry="${esc(row.id)}" title="加入${esc(listLabelOf(kind))}" aria-label="加入${esc(listLabelOf(kind))}">＋</button>`}</td>`).join('')}
          <td><button type="button" class="cat-edit-btn" data-cat-edit="${esc(row.id)}">改分类</button></td>
        </tr>`).join('');
      return `<table class="plain-table">
        <thead><tr>
          <th>编号</th><th>时间</th><th>金额</th>
          ${showObject ? '<th>交易对象</th>' : ''}
          ${showCategory ? '<th>分类</th>' : ''}
          <th>备注</th>
          ${listAddKinds.map(kind => `<th>${esc(listLabelOf(kind))}</th>`).join('')}
          <th>操作</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="${cols}" class="muted">暂无数据</td></tr>`}</tbody>
      </table>`;
    }

    // ═══════════ 账单页：三个入口 ═══════════
    function renderEntryView() {
      const list = $('entryTable');
      const browser = $('categoryBrowser');
      const cp = $('counterpartyView');
      if (!list || !browser || !cp) return;
      list.classList.toggle('hidden', entryViewMode !== 'list');
      browser.classList.toggle('hidden', entryViewMode !== 'category');
      cp.classList.toggle('hidden', entryViewMode !== 'counterparty');
      if ($('searchWrap')) $('searchWrap').classList.toggle('hidden', entryViewMode !== 'list');
      document.querySelectorAll('[data-entry-mode]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.entryMode === entryViewMode));
      if (entryViewMode === 'list') renderEntries();
      else if (entryViewMode === 'category') renderCategoryBrowser();
      else renderCounterpartyView();
    }

    document.querySelectorAll('[data-entry-mode]').forEach(btn => btn.onclick = () => {
      entryViewMode = btn.dataset.entryMode;
      renderEntryView();
    });

    function typeTabsHtml(active, attr) {
      return `<div class="type-tabs">${entryTypes.map(name =>
        `<button type="button" class="${name === active ? 'active' : ''}" data-${attr}="${esc(name)}">${esc(name)}</button>`
      ).join('')}</div>`;
    }

    // ═══════════ 按分类查找 ═══════════
    function browserCurrentType() {
      if (entryTypes.includes(browserType)) return browserType;
      return entryTypes.includes('支出') ? '支出' : (entryTypes[0] || '');
    }

    function browserRows(category, type) {
      return entries
        .filter(row => row.category === category && row.type === type)
        .sort((a, b) => String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
    }

    function browserCount(prefix, type) {
      return entries.filter(row => row.type === type
        && (row.category === prefix || String(row.category || '').startsWith(prefix + '/'))).length;
    }

    function renderCategoryBrowser() {
      const wrap = $('categoryBrowser');
      if (!wrap) return;
      const type = browserCurrentType();
      browserType = type;
      const groups = categoryTree[type] || {};
      const tabs = typeTabsHtml(type, 'browser-type');
      let body = '';

      if (browserGroup && browserLeaf) {
        const all = browserRows(browserLeaf, type);
        const months = [...new Set(all.map(row => String(row.transaction_time || '').slice(0, 7)).filter(Boolean))].sort().reverse();
        if (browserMonth !== 'all' && !months.includes(browserMonth)) browserMonth = months[0] || '';
        const rows = browserMonth === 'all' ? all : all.filter(row => String(row.transaction_time || '').slice(0, 7) === browserMonth);
        const net = rows.reduce((total, row) => total + (isIncomeRow(row) ? 1 : -1) * (Number(row.amount_cents) || 0), 0);
        const monthChips = months.length ? `<div class="month-chips">${months.map(month =>
          `<button type="button" class="${browserMonth === month ? 'active' : ''}" data-browser-month="${esc(month)}">${esc(month)}</button>`
        ).join('')}<button type="button" class="${browserMonth === 'all' ? 'active' : ''}" data-browser-month="all">全部</button></div>` : '';
        body = `
          <div class="browser-bar">
            <button class="secondary" data-browser-back="group">‹ 返回小分类</button>
            <button class="secondary" data-browser-back="root">← 返回大分类</button>
            <span class="browser-path">${esc(categoryLabel(browserLeaf))}</span>
            <span class="muted">共 ${rows.length} 条 · ${net < 0 ? '-' : '+'}${money(Math.abs(net))}</span>
          </div>
          ${monthChips}
          ${readOnlyEntryTable(rows, {showObject: true, showCategory: false})}`;
      } else if (browserGroup) {
        const leaves = groups[browserGroup] || [];
        const groupCount = browserCount(browserGroup, type);
        const chips = leaves.length
          ? leaves.map(leaf => {
              const target = categoryPath(browserGroup, leaf);
              return `<button type="button" class="chip picker-leaf" data-browser-leaf="${esc(target)}">${esc(leaf)}<span class="picker-count">${browserRows(target, type).length}</span></button>`;
            }).join('')
          : `<button type="button" class="chip picker-leaf picker-direct" data-browser-leaf="${esc(browserGroup)}">直接用「${esc(browserGroup)}」<span class="picker-count">${groupCount}</span></button>`;
        body = `
          <div class="browser-bar">
            <button class="secondary" data-browser-back="root">← 返回大分类</button>
            <span class="browser-path">${esc(browserGroup)}</span>
            <span class="muted">共 ${groupCount} 条</span>
          </div>
          <div class="browser-leaves">${chips}</div>`;
      } else {
        const names = Object.keys(groups);
        body = names.length ? `<div class="browser-grid">${names.map(group => {
          const leaves = groups[group] || [];
          return `<button type="button" class="browser-card" data-browser-group="${esc(group)}">
            <strong>${esc(group)}</strong>
            <em>${leaves.length ? leaves.length + ' 个小分类' : '无小分类'} · ${browserCount(group, type)} 条账目</em>
          </button>`;
        }).join('')}</div>` : '<div class="muted">这个类型下还没有大分类。到「设置 → 修改分类」里建。</div>';
      }

      wrap.innerHTML = tabs + body;
      wrap.querySelectorAll('[data-browser-type]').forEach(btn => btn.onclick = () => {
        browserType = btn.dataset.browserType;
        browserGroup = '';
        browserLeaf = '';
        browserMonth = '';
        renderCategoryBrowser();
      });
      wrap.querySelectorAll('[data-browser-group]').forEach(btn => btn.onclick = () => {
        browserGroup = btn.dataset.browserGroup;
        browserLeaf = '';
        browserMonth = '';
        renderCategoryBrowser();
      });
      wrap.querySelectorAll('[data-browser-leaf]').forEach(btn => btn.onclick = () => {
        browserLeaf = btn.dataset.browserLeaf;
        browserMonth = '';
        renderCategoryBrowser();
      });
      wrap.querySelectorAll('[data-browser-month]').forEach(btn => btn.onclick = () => {
        browserMonth = btn.dataset.browserMonth;
        renderCategoryBrowser();
      });
      wrap.querySelectorAll('[data-browser-back]').forEach(btn => btn.onclick = () => {
        if (btn.dataset.browserBack === 'group') browserLeaf = '';
        else {
          browserGroup = '';
          browserLeaf = '';
        }
        renderCategoryBrowser();
      });
    }

    // ═══════════ 交互消费统计 ═══════════
    function counterpartyNameOf(row) {
      const name = String(row.transaction_object || '').trim();
      return name || '（未填写对象）';
    }

    function listItems(kind) {
      return counterpartyListItems.filter(item => item.kind === kind);
    }

    function listSet(kind) {
      return new Set(listItems(kind).filter(i => i.target_type === 'object').map(i => i.object_name));
    }

    function entryIdSet(kind) {
      return new Set(listItems(kind).filter(i => i.target_type === 'entry').map(i => Number(i.entry_id)));
    }

    // ── 筛选：时间（月/日）在聚合前生效，笔数与数额区间在聚合后作用于对象 ──
    function cpFilterActive() {
      return Boolean(cpFilter.month || cpFilter.day || cpFilter.minCount || cpFilter.maxCount || cpFilter.minAmount || cpFilter.maxAmount);
    }

    function cpNumberOrNull(value) {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const num = Number(raw);
      return Number.isFinite(num) ? num : null;
    }

    function cpScopedEntries() {
      return entries.filter(row => {
        // 转账 / 余额修正 / 期初资金 都是「计余额、不计收支」的，不能进消费对象统计
        if (isNonReporting(row)) return false;
        const day = entryDay(row);
        if (cpFilter.month && day.slice(5, 7) !== cpFilter.month) return false;
        if (cpFilter.day && day.slice(8, 10) !== cpFilter.day) return false;
        return true;
      });
    }

    function cpAmountValue(item) {
      if (cpAmountSort === 'expense') return item.expense;
      if (cpAmountSort === 'income') return item.income;
      return item.expense + item.income;
    }

    function cpSortValue(item) {
      if (cpSort === 'count') return item.count;
      return cpAmountValue(item);
    }

    function cpItemMatchesFilters(item) {
      const minCount = cpNumberOrNull(cpFilter.minCount);
      const maxCount = cpNumberOrNull(cpFilter.maxCount);
      if (minCount !== null && item.count < minCount) return false;
      if (maxCount !== null && item.count > maxCount) return false;
      const minAmount = cpNumberOrNull(cpFilter.minAmount);
      const maxAmount = cpNumberOrNull(cpFilter.maxAmount);
      if (minAmount !== null || maxAmount !== null) {
        const amount = cpAmountValue(item) / 100;
        if (minAmount !== null && amount < minAmount) return false;
        if (maxAmount !== null && amount > maxAmount) return false;
      }
      return true;
    }

    function buildCounterpartyStats(options = {}) {
      const map = new Map();
      (options.all ? entries.filter(row => !isNonReporting(row)) : cpScopedEntries()).forEach(row => {
        const name = counterpartyNameOf(row);
        if (!map.has(name)) map.set(name, {name, expense: 0, income: 0, count: 0, rows: [], categoryCounts: new Map()});
        const item = map.get(name);
        item.count += 1;
        item.rows.push(row);
        const amount = Number(row.amount_cents) || 0;
        if (isIncomeRow(row)) item.income += amount;
        else item.expense += amount;
        if (row.category) item.categoryCounts.set(row.category, (item.categoryCounts.get(row.category) || 0) + 1);
      });
      const list = [...map.values()];
      list.forEach(item => {
        const ranked = [...item.categoryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
        item.category = ranked.length ? ranked[0][0] : '';
      });
      list.sort(cpCompare);
      return list;
    }

    function cpCompare(a, b) {
      const dir = cpSortAsc ? -1 : 1;
      const diff = cpSortValue(b) - cpSortValue(a);
      if (diff) return diff * dir;
      const total = (b.expense + b.income) - (a.expense + a.income);
      if (total) return total * dir;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    }

    // 按「消费对象 × 小分类」拆开，看清一个对象里的钱都花在哪些分类
    function buildCounterpartyBreakdown() {
      const objects = new Map();
      cpScopedEntries().forEach(row => {
        const name = counterpartyNameOf(row);
        const category = row.category ? String(categoryLabel(row.category)).split('·').pop() : '未分类';
        if (!objects.has(name)) objects.set(name, {name, expense: 0, income: 0, count: 0, groups: new Map()});
        const item = objects.get(name);
        const amount = Number(row.amount_cents) || 0;
        const income = isIncomeRow(row);
        item.count += 1;
        if (income) item.income += amount; else item.expense += amount;
        const group = item.groups.get(category) || {category, expense: 0, income: 0, count: 0};
        group.count += 1;
        if (income) group.income += amount; else group.expense += amount;
        item.groups.set(category, group);
      });
      const list = [...objects.values()];
      list.forEach(item => {
        item.groups = [...item.groups.values()].sort((a, b) =>
          (b.expense - a.expense) || (b.income - a.income) || a.category.localeCompare(b.category, 'zh-Hans-CN'));
      });
      list.sort(cpCompare);
      return list;
    }

    function cpSwitchers() {
      const modeBtn = (value, text) =>
        `<button type="button" class="${cpMode === value ? 'active' : ''}" data-cp-mode="${value}">${text}</button>`;
      const amountOptions = [['expense', '支出'], ['income', '收入'], ['total', '总金额']];
      return `<div class="cp-switchers">
        <div class="view-tabs">${modeBtn('object', '按对象')}${modeBtn('detail', '按对象 + 小分类')}</div>
        <label class="cp-amount-picker">按数额
          <select id="cpAmountSort" aria-label="按数额排序">
            ${amountOptions.map(([value, text]) =>
              `<option value="${value}"${cpAmountSort === value ? ' selected' : ''}>${text}</option>`).join('')}
          </select>
        </label>
      </div>`;
    }

    function cpMonthOptions() {
      return [...new Set(entries.map(row => entryDay(row).slice(5, 7)).filter(Boolean))].sort();
    }

    function cpMonthYear() {
      const years = entries.map(row => entryDay(row).slice(0, 4)).filter(Boolean).sort();
      return years.length ? Number(years[years.length - 1]) : new Date().getFullYear();
    }

    function cpDayOptions() {
      if (!cpFilter.month) return [];
      const maxDay = new Date(cpMonthYear(), Number(cpFilter.month), 0).getDate();
      return Array.from({length: maxDay}, (_, i) => pad2(i + 1));
    }

    function cpAmountLabel() {
      return cpAmountSort === 'expense' ? '支出' : cpAmountSort === 'income' ? '收入' : '总金额';
    }

    function cpSortLabel() {
      if (cpSort === 'count') return `笔数${cpSortAsc ? '从少到多' : '从多到少'}`;
      return `${cpAmountLabel()}${cpSortAsc ? '从小到大' : '从大到小'}`;
    }

    function cpFilterBar() {
      const months = cpMonthOptions();
      const days = cpDayOptions();
      const amountLabel = cpAmountLabel();
      return `<div class="batch-filters cp-filters">
        <label>月
          <select id="cpFilterMonth">
            <option value="">全部</option>
            ${months.map(month => `<option value="${esc(month)}"${cpFilter.month === month ? ' selected' : ''}>${Number(month)} 月</option>`).join('')}
          </select>
        </label>
        <label>日
          <select id="cpFilterDay"${cpFilter.month ? '' : ' disabled'}>
            <option value="">整月</option>
            ${days.map(day => `<option value="${esc(day)}"${cpFilter.day === day ? ' selected' : ''}>${Number(day)} 日</option>`).join('')}
          </select>
        </label>
        <label>笔数 ≥
          <input id="cpFilterMinCount" type="number" min="0" step="1" placeholder="不限" value="${esc(cpFilter.minCount)}">
        </label>
        <label>笔数 ≤
          <input id="cpFilterMaxCount" type="number" min="0" step="1" placeholder="不限" value="${esc(cpFilter.maxCount)}">
        </label>
        <label>${esc(amountLabel)} ≥
          <input id="cpFilterMinAmount" type="number" min="0" step="0.01" placeholder="不限" value="${esc(cpFilter.minAmount)}">
        </label>
        <label>${esc(amountLabel)} ≤
          <input id="cpFilterMaxAmount" type="number" min="0" step="0.01" placeholder="不限" value="${esc(cpFilter.maxAmount)}">
        </label>
        <div class="batch-actions">
          <button type="button" class="secondary" id="cpClearFilters"${cpFilterActive() ? '' : ' disabled'}>清除筛选</button>
        </div>
      </div>`;
    }

    // 置顶名单 → 交互消费统计顶部 3 个快捷位；空槽位给「＋空名单」按钮
    function pinnedListDefs() {
      // listDefs 拉取失败时回退到两条默认，保证界面不空
      const defs = listDefs.length
        ? listDefs
        : [{key: 'whitelist', label: '白名单', pinned: 1, sort_order: 10},
           {key: 'large', label: '大额名单', pinned: 1, sort_order: 20}];
      return defs
        .filter(def => def && Number(def.pinned) === 1)
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
        .slice(0, CP_SLOT_COUNT);
    }

    function cpLabelSlotHtml(def) {
      const kind = def.key;
      const hidden = cpHiddenKinds.has(kind);
      return `
        <span class="cp-label${hidden ? ' is-hidden' : ''}" data-cp-label="${esc(kind)}">
          ${esc(def.label)}<span class="tag-count">${listItems(kind).length}</span>${hidden ? '<span class="mark-hidden">×</span>' : ''}
          ${cpMenuOpen === kind ? `<span class="cp-label-menu">
            <button type="button" data-cp-hide="${esc(kind)}">${hidden ? '恢复显示' : '暂时隐藏'}</button>
            <button type="button" data-cp-jump="${esc(kind)}">跳转</button>
          </span>` : ''}
        </span>`;
    }

    function cpEmptySlotHtml() {
      return `
        <span class="cp-label cp-label-empty" data-cp-empty-slot="1">
          <span class="cp-empty-cap">空名单</span>
          <button type="button" class="cp-empty-add" data-cp-new-slot="1" title="建立一个新名单并占用这个快捷位" aria-label="建立名单">＋</button>
        </span>`;
    }

    function renderCpLabels() {
      const pinned = pinnedListDefs();
      const slots = [];
      for (let slot = 0; slot < CP_SLOT_COUNT; slot += 1) {
        const def = pinned[slot];
        slots.push(def ? cpLabelSlotHtml(def) : cpEmptySlotHtml());
      }
      return `<div class="cp-labels">${slots.join('')}</div>`;
    }

    function cpSortHead(field, text) {
      const active = cpSort === field;
      const mark = active ? (cpSortAsc ? ' ↑' : ' ↓') : '';
      return `<th class="cp-sortable${active ? ' is-sorted' : ''}" data-cp-col-sort="${field}" title="点击按此列排序">${esc(text)}<span class="cp-sort-mark">${mark}</span></th>`;
    }

    function renderCounterpartyTable() {
      const hidden = new Set();
      cpHiddenKinds.forEach(kind => listSet(kind).forEach(name => hidden.add(name)));
      const allItems = buildCounterpartyStats();
      const visibleItems = allItems.filter(item => !hidden.has(item.name) && cpItemMatchesFilters(item));
      const filteredOut = allItems.length - visibleItems.length;
      const head = `
        ${renderCpLabels()}
        ${cpSwitchers()}
        ${cpFilterBar()}
        <div class="entry-controls"><div class="muted">共 ${visibleItems.length} 个消费对象${filteredOut ? `（原始 ${allItems.length} 个，已筛掉 ${filteredOut} 个）` : ''}，按${cpSortLabel()}${hidden.size ? ` · 已隐藏 ${hidden.size} 个` : ''}</div></div>`;

      if (cpMode === 'detail') {
        const groups = buildCounterpartyBreakdown().filter(item => !hidden.has(item.name) && cpItemMatchesFilters(item));
        const body = groups.map((item, index) => `
          <tr class="is-clickable cp-parent" data-cp-object="${esc(item.name)}">
            <td class="num-cell">${index + 1}</td>
            <td><strong>${esc(item.name)}</strong></td>
            <td class="money-cell">${esc(signedMoney(item.expense, 'expense'))}</td>
            <td class="money-cell">${esc(signedMoney(item.income, 'income'))}</td>
            <td>${item.count}</td>
          </tr>
          ${item.groups.map(group => `
            <tr class="cp-child">
              <td></td>
              <td class="cp-child-name">└ ${esc(group.category)}</td>
              <td class="money-cell">${esc(signedMoney(group.expense, 'expense'))}</td>
              <td class="money-cell">${esc(signedMoney(group.income, 'income'))}</td>
              <td>${group.count}</td>
            </tr>`).join('')}`).join('');
        return `${head}
          <table class="plain-table cp-table">
            <thead><tr><th>排名</th><th>消费对象 / 小分类</th>${cpSortHead('expense', '支出')}${cpSortHead('income', '收入')}${cpSortHead('count', '笔数')}</tr></thead>
            <tbody>${body || '<tr><td colspan="5" class="muted">没有可统计的对象</td></tr>'}</tbody>
          </table>`;
      }

      const body = visibleItems.map((item, index) => `
        <tr class="is-clickable" data-cp-object="${esc(item.name)}">
          <td class="num-cell">${index + 1}</td>
          <td>${esc(item.name)}</td>
          <td class="money-cell">${esc(signedMoney(item.expense, 'expense'))}</td>
          <td class="money-cell">${esc(signedMoney(item.income, 'income'))}</td>
          <td>${item.count}</td>
        </tr>`).join('');
      return `${head}
        <table class="plain-table">
          <thead><tr><th>排名</th><th>消费对象</th>${cpSortHead('expense', '支出')}${cpSortHead('income', '收入')}${cpSortHead('count', '笔数')}</tr></thead>
          <tbody>${body || '<tr><td colspan="5" class="muted">没有可统计的对象</td></tr>'}</tbody>
        </table>`;
    }

    // 该消费对象的最早 / 最晚流水日期（作为日期筛选的默认范围）
    function cpDateBounds(rows) {
      const days = rows.map(row => entryDay(row)).filter(Boolean).sort();
      return {min: days[0] || '', max: days[days.length - 1] || ''};
    }

    function renderCounterpartyDetail() {
      const item = buildCounterpartyStats({all: true}).find(row => row.name === counterpartyObject);
      const rows = item ? item.rows : [];
      const bounds = cpDateBounds(rows);
      const from = cpDateFrom || bounds.min;
      const to = cpDateTo || bounds.max;
      const scoped = rows
        .filter(row => {
          const day = entryDay(row);
          if (!day) return false;
          if (from && day < from) return false;
          if (to && day > to) return false;
          return true;
        })
        .sort((a, b) => String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
      const expense = scoped.filter(row => !isIncomeRow(row)).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
      const income = scoped.filter(row => isIncomeRow(row)).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
      const inWhite = listSet('whitelist').has(counterpartyObject);
      const inLarge = listSet('large').has(counterpartyObject);
      const whiteBtn = listDefByKey('whitelist')
        ? `<button type="button" class="secondary" data-cp-toggle-whitelist="${esc(counterpartyObject)}">${inWhite ? '移出白名单' : '加入白名单'}</button>`
        : '';
      const largeBtn = listDefByKey('large')
        ? `<button type="button" class="secondary" data-cp-toggle-large="${esc(counterpartyObject)}">${inLarge ? '移出大额名单' : '加入大额名单'}</button>`
        : '';
      const custom = Boolean(cpDateFrom || cpDateTo);
      const rangeText = `${from || '最早'} ~ ${to || '最晚'}`;
      return `
        ${renderCpLabels()}
        <div class="browser-bar">
          <button class="secondary" data-cp-back="table">← 返回消费对象列表</button>
          <span class="browser-path">${esc(counterpartyObject)}</span>
          ${whiteBtn}
          ${largeBtn}
        </div>
        <div class="cp-date-range">
          <label class="cp-date-field">起始日期
            <input type="date" class="cp-date-input" id="cpDateFrom" value="${esc(cpDateFrom)}" aria-label="起始日期">
          </label>
          <span class="cp-date-sep">-</span>
          <label class="cp-date-field">截止日期
            <input type="date" class="cp-date-input" id="cpDateTo" value="${esc(cpDateTo)}" aria-label="截止日期">
          </label>
          ${custom ? '<button type="button" class="secondary" data-cp-date-reset="1">回到全部日期</button>' : ''}
          <span class="muted cp-date-hint">${custom ? '当前筛选：' : '日期：'}<b>${esc(rangeText)}</b>${custom ? '' : '（该对象全部流水）'}</span>
        </div>
        <div class="entry-controls"><div class="muted">${esc(rangeText)}：支出 ${esc(signedMoney(expense, 'expense'))} · 收入 ${esc(signedMoney(income, 'income'))} · ${scoped.length} 笔</div></div>
        ${scoped.length ? readOnlyEntryTable(scoped, {showObject: false, showCategory: true, listAddKinds: ['whitelist', 'large']}) : '<div class="muted">这个日期范围内没有记录</div>'}`;
    }

    function renderListPanel(kind) {
      const items = listItems(kind);
      const title = listLabelOf(kind);
      const rows = items.map(item => {
        const main = item.target_type === 'object'
          ? `<strong>${esc(item.object_name || '')}</strong><div class="list-sub">整个消费对象</div>`
          : `<strong>${esc(item.label || ('账目 #' + (entryNumberMap[Number(item.entry_id)] || item.entry_id)))}</strong>
             <div class="list-sub">${esc(item.transaction_time || '')} · ${esc(categoryLabel(item.category) || '未分类')} · ${esc(signedMoney(Number(item.amount_cents) || 0, item.type === '收入' ? 'income' : 'expense'))}</div>`;
        return `<div class="list-row">
          <div class="list-main">${main}</div>
          ${cpPanelEdit ? `<input class="tag-note" data-list-note="${esc(item.id)}" value="${esc(item.note || '')}" placeholder="备注">
            <button type="button" class="secondary" data-list-save="${esc(item.id)}">保存</button>
            <button type="button" class="text-delete" data-list-delete="${esc(item.id)}">删除</button>` : ''}
        </div>`;
      }).join('');
      return `
        <div class="browser-bar">
          <button class="secondary" data-cp-back="table">← 返回统计</button>
          <span class="browser-path">${esc(title)}</span>
          <span class="muted">${items.length} 项</span>
          <button type="button" class="${cpPanelEdit ? 'primary' : 'secondary'}" data-list-edit="1">${cpPanelEdit ? '结束修改' : '修改'}</button>
        </div>
        <div class="section">${rows || '<div class="muted">名单是空的</div>'}</div>`;
    }

    function renderCounterpartyView() {
      const wrap = $('counterpartyView');
      if (!wrap) return;
      if (cpPanel) wrap.innerHTML = renderListPanel(cpPanel);
      else if (counterpartyObject) wrap.innerHTML = renderCounterpartyDetail();
      else wrap.innerHTML = renderCounterpartyTable();
      bindCounterpartyEvents();
    }

    async function reloadCounterpartyLists() {
      counterpartyListItems = await api('/api/counterparty-lists');
    }

    async function reloadListDefs() {
      listDefs = await api('/api/list-defs');
      return listDefs;
    }

    // ═══════════ 设置页：特殊名单 ═══════════
    function renderSpecialLists() {
      const body = $('specialListBody');
      const toggle = $('specialListToggle');
      if (!body) return;
      if (toggle) {
        toggle.setAttribute('aria-expanded', specialListOpen ? 'true' : 'false');
        toggle.classList.toggle('is-open', specialListOpen);
        const arrow = toggle.querySelector('.settings-collapse-arrow');
        if (arrow) arrow.textContent = specialListOpen ? '▴' : '▾';
      }
      body.classList.toggle('hidden', !specialListOpen);
      if (!specialListOpen) return;

      const editing = specialListEditing;
      const rows = listDefs.map(def => {
        const count = Number(def.item_count || 0);
        const key = String(def.key);
        const pinned = Number(def.pinned) === 1;
        const isEditing = editing && editing.mode === 'rename' && editing.key === key;
        const main = isEditing
          ? `<input class="special-list-input" data-list-def-input="rename" value="${esc(editing.label)}" placeholder="名单名">`
          : `<strong>${esc(def.label)}</strong>${pinned ? '<span class="special-list-pin-tag">已置顶</span>' : ''}`;
        const actions = isEditing
          ? `<button type="button" class="primary" data-list-def-submit="rename" data-list-def-key="${esc(key)}">保存</button>
             <button type="button" class="secondary" data-list-def-cancel="1">取消</button>`
          : `<button type="button" class="secondary" data-list-def-pin="${esc(key)}" data-pin-next="${pinned ? 0 : 1}">${pinned ? '取消置顶' : '置顶'}</button>
             <button type="button" class="secondary" data-list-def-manage="${esc(key)}">${specialListManageKey === key ? '收起条目' : '管理条目'}</button>
             <button type="button" class="secondary" data-list-def-rename="${esc(key)}">改名</button>
             <button type="button" class="text-delete" data-list-def-delete="${esc(key)}">删除</button>`;
        const confirmPanel = specialListDeleteKey === key
          ? `<div class="special-list-confirm">
               <div>删除名单「<strong>${esc(def.label)}</strong>」？该名单下的 <strong>${count}</strong> 条记录会一并删除，删除后不可恢复。</div>
               <div class="special-list-confirm-actions">
                 <button type="button" class="secondary" data-list-def-delete-cancel="1">取消</button>
                 <button type="button" class="primary" data-list-def-delete-confirm="${esc(key)}">确认删除</button>
               </div>
             </div>`
          : '';
        const managePanel = specialListManageKey === key ? renderListManagePanel(def) : '';
        return `<div class="special-list-row">
            <div class="special-list-main">
              ${main}
              <span class="muted">${def.is_default ? '默认名单 · ' : ''}${count} 条</span>
            </div>
            <div class="special-list-actions">${actions}</div>
          </div>${confirmPanel}${managePanel}`;
      }).join('');

      const newForm = `<div class="special-list-new">
          <button type="button" class="secondary" data-list-def-new="1">＋ 新建名单</button>
          <span class="muted">新建时可选择「复制自」某个名单</span>
        </div>`;

      body.innerHTML = `
        <div class="special-list-title muted">默认名单与自定义名单：在「账单 → 交互消费统计」里都能一键隐藏 / 筛选</div>
        ${rows || '<div class="muted">还没有名单</div>'}
        ${newForm}
        ${specialListMsg ? `<div class="special-list-msg">${esc(specialListMsg)}</div>` : ''}`;

      body.querySelectorAll('[data-list-def-new]').forEach(btn => btn.onclick = () => {
        specialListEditing = null;
        specialListDeleteKey = '';
        specialListMsg = '';
        openNewListDialog({autoPin: false});
      });
      body.querySelectorAll('[data-list-def-pin]').forEach(btn => btn.onclick = () => {
        toggleListDefPin(btn.dataset.listDefPin, btn.dataset.pinNext === '1');
      });
      body.querySelectorAll('[data-list-def-manage]').forEach(btn => btn.onclick = () => {
        const key = btn.dataset.listDefManage;
        if (specialListManageKey === key) {
          specialListManageKey = '';
          specialListManageQuery = '';
        } else {
          specialListManageKey = key;
          specialListManageQuery = '';
        }
        specialListEditing = null;
        specialListDeleteKey = '';
        specialListMsg = '';
        renderSpecialLists();
        if (specialListManageKey) renderSpecialListCandidates();
      });
      body.querySelectorAll('[data-manage-close]').forEach(btn => btn.onclick = () => {
        specialListManageKey = '';
        specialListManageQuery = '';
        renderSpecialLists();
      });
      body.querySelectorAll('[data-manage-remove]').forEach(btn => btn.onclick = () => {
        removeItemFromManage(btn.dataset.manageRemove);
      });
      const manageSearch = body.querySelector('#specialListManageSearch');
      if (manageSearch) {
        manageSearch.oninput = () => {
          specialListManageQuery = manageSearch.value;
          renderSpecialListCandidates();
        };
        renderSpecialListCandidates();
      }
      body.querySelectorAll('[data-list-def-rename]').forEach(btn => btn.onclick = () => {
        const key = btn.dataset.listDefRename;
        const def = listDefs.find(item => item.key === key);
        specialListEditing = {mode: 'rename', key, label: def ? def.label : ''};
        specialListDeleteKey = '';
        specialListMsg = '';
        renderSpecialLists();
        const input = body.querySelector('[data-list-def-input="rename"]');
        if (input) { input.focus(); input.select(); }
      });
      body.querySelectorAll('[data-list-def-cancel]').forEach(btn => btn.onclick = () => {
        specialListEditing = null;
        specialListDeleteKey = '';
        specialListMsg = '';
        renderSpecialLists();
      });
      body.querySelectorAll('[data-list-def-submit]').forEach(btn => btn.onclick = () => {
        const input = body.querySelector(`[data-list-def-input="${btn.dataset.listDefSubmit}"]`);
        submitListDef(btn.dataset.listDefSubmit, btn.dataset.listDefKey || '', input ? input.value : '');
      });
      body.querySelectorAll('[data-list-def-input]').forEach(input => {
        input.onkeydown = (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const isRename = input.dataset.listDefInput === 'rename';
          const key = isRename && specialListEditing ? specialListEditing.key : '';
          submitListDef(isRename ? 'rename' : 'new', key, input.value);
        };
      });
      body.querySelectorAll('[data-list-def-delete]').forEach(btn => btn.onclick = () => {
        specialListDeleteKey = btn.dataset.listDefDelete;
        specialListEditing = null;
        specialListMsg = '';
        renderSpecialLists();
      });
      body.querySelectorAll('[data-list-def-delete-cancel]').forEach(btn => btn.onclick = () => {
        specialListDeleteKey = '';
        specialListMsg = '';
        renderSpecialLists();
      });
      body.querySelectorAll('[data-list-def-delete-confirm]').forEach(btn => btn.onclick = () => {
        deleteListDef(btn.dataset.listDefDeleteConfirm);
      });
    }

    async function submitListDef(mode, key, rawValue) {
      const label = String(rawValue || '').trim();
      if (!label) {
        specialListMsg = '名单名不能为空';
        renderSpecialLists();
        return;
      }
      try {
        if (mode === 'rename') {
          await api('/api/list-def-rename', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({key, label})
          });
        } else {
          await api('/api/list-def-add', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({label})
          });
        }
        specialListEditing = null;
        specialListMsg = '';
        await reloadListDefs();
        $('status').textContent = mode === 'rename' ? `已改名：${label}` : `已新建名单：${label}`;
      } catch (err) {
        specialListMsg = err.message;
      }
      renderSpecialLists();
      renderCounterpartyView();
    }

    async function deleteListDef(key) {
      try {
        const res = await api('/api/list-def-delete', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({key})
        });
        specialListDeleteKey = '';
        specialListMsg = '';
        cpHiddenKinds.delete(key);
        await Promise.all([reloadListDefs(), reloadCounterpartyLists()]);
        $('status').textContent = `已删除名单，连带移除 ${Number(res.removed_items || 0)} 条记录`;
      } catch (err) {
        specialListMsg = err.message;
      }
      renderSpecialLists();
      renderCounterpartyView();
    }

    // ═══════════ 新建名单对话框（名 + 可选「复制自」） ═══════════
    function newListCopyOptions() {
      const opts = ['<option value="">不复制</option>'];
      listDefs.forEach(def => {
        opts.push(`<option value="${esc(def.key)}">${esc(def.label)}（${Number(def.item_count || 0)} 条）</option>`);
      });
      return opts.join('');
    }

    function openNewListDialog(options = {}) {
      const dialog = $('newListDialog');
      if (!dialog) return;
      newListDialogAutoPin = options.autoPin === true;
      dialog.classList.remove('hidden');
      const nameInput = $('newListName');
      if (nameInput) {
        nameInput.value = '';
        nameInput.focus();
      }
      const copySelect = $('newListCopyFrom');
      if (copySelect) {
        copySelect.innerHTML = newListCopyOptions();
        copySelect.value = '';
      }
      const msg = $('newListMsg');
      if (msg) msg.textContent = '';
      const hint = $('newListHint');
      if (hint) hint.textContent = newListDialogAutoPin ? '建好后会自动置顶，占用这个快捷位' : '';
    }

    function closeNewListDialog() {
      const dialog = $('newListDialog');
      if (dialog) dialog.classList.add('hidden');
      newListDialogAutoPin = false;
    }

    async function submitNewListDialog() {
      const nameInput = $('newListName');
      const copySelect = $('newListCopyFrom');
      const label = String(nameInput ? nameInput.value : '').trim();
      const copyFrom = String(copySelect ? copySelect.value : '').trim();
      const msg = $('newListMsg');
      if (!label) {
        if (msg) msg.textContent = '名单名不能为空';
        return;
      }
      const autoPin = newListDialogAutoPin;
      let created = null;
      try {
        created = await api('/api/list-def-add', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({label, copy_from: copyFrom || null})
        });
      } catch (err) {
        if (msg) msg.textContent = err.message;
        return;
      }
      let pinNote = '';
      if (autoPin) {
        try {
          await api('/api/list-def-pin', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({key: created.key, pinned: true})
          });
          pinNote = '，已置顶到快捷位';
        } catch (pinErr) {
          pinNote = `，但置顶失败：${pinErr.message}`;
        }
      }
      closeNewListDialog();
      await Promise.all([reloadListDefs(), reloadCounterpartyLists()]);
      const copied = Number(created.copied || 0);
      $('status').textContent = `已新建名单：${label}${copied > 0 ? `，已复制 ${copied} 条` : ''}${pinNote}`;
      renderSpecialLists();
      renderCounterpartyView();
    }

    if ($('newListConfirm')) $('newListConfirm').onclick = () => { submitNewListDialog().catch(err => $('status').textContent = err.message); };
    if ($('newListCancel')) $('newListCancel').onclick = () => closeNewListDialog();
    if ($('closeNewListDialog')) $('closeNewListDialog').onclick = () => closeNewListDialog();
    if ($('newListDialog')) $('newListDialog').onclick = (event) => {
      if (event.target === $('newListDialog')) closeNewListDialog();
    };
    if ($('newListName')) $('newListName').onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitNewListDialog().catch(err => $('status').textContent = err.message);
    };

    // ═══════════ 设置页：名单条目维护（增 / 删） ═══════════
    function renderListManagePanel(def) {
      const items = listItems(def.key);
      const rows = items.map(item => {
        const main = item.target_type === 'object'
          ? `<strong>${esc(item.object_name || '')}</strong><div class="list-sub">整个消费对象</div>`
          : `<strong>${esc(item.label || ('账目 #' + (entryNumberMap[Number(item.entry_id)] || item.entry_id)))}</strong>
             <div class="list-sub">${esc(item.transaction_time || '')} · ${esc(categoryLabel(item.category) || '未分类')} · ${esc(signedMoney(Number(item.amount_cents) || 0, item.type === '收入' ? 'income' : 'expense'))}</div>`;
        return `<div class="list-row">
          <div class="list-main">${main}</div>
          <button type="button" class="text-delete" data-manage-remove="${esc(item.id)}">删除</button>
        </div>`;
      }).join('');
      return `<div class="special-list-manage">
        <div class="special-list-manage-head">
          <strong>${esc(def.label)}</strong>
          <span class="muted">共 ${items.length} 条</span>
          <button type="button" class="secondary" data-manage-close="1">收起</button>
        </div>
        <div class="special-list-manage-items">${rows || '<div class="muted">这个名单还是空的</div>'}</div>
        <div class="special-list-manage-add">
          <label class="special-list-manage-search">添加消费对象
            <input class="special-list-input" id="specialListManageSearch" placeholder="搜索交易对象，例如：淘宝、食堂；点候选即加入" value="${esc(specialListManageQuery)}">
          </label>
          <div class="special-list-candidates" id="specialListCandidates"></div>
        </div>
      </div>`;
    }

    // 候选只重绘自己，不碰搜索框，避免输入时丢焦点
    function renderSpecialListCandidates() {
      const wrap = $('specialListCandidates');
      if (!wrap) return;
      const def = listDefByKey(specialListManageKey);
      if (!def) {
        wrap.innerHTML = '';
        return;
      }
      const inList = new Set(
        listItems(def.key).filter(item => item.target_type === 'object').map(item => item.object_name)
      );
      const counts = new Map();
      entries.forEach(row => {
        // 非收支援引类型（转账/余额修正/期初资金）不该出现在「消费对象」候选里
        if (isNonReporting(row)) return;
        const name = counterpartyNameOf(row);
        counts.set(name, (counts.get(name) || 0) + 1);
      });
      const q = String(specialListManageQuery || '').trim();
      let candidates = [...counts.entries()].filter(([name]) => !inList.has(name));
      if (q) candidates = candidates.filter(([name]) => name.includes(q));
      candidates.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
      const shown = candidates.slice(0, 20);
      wrap.innerHTML = shown.length
        ? shown.map(([name, count]) =>
            `<button type="button" class="chip picker-leaf" data-manage-add="${esc(name)}">${esc(name)}<span class="picker-count">${count}</span></button>`
          ).join('') + (candidates.length > shown.length
            ? `<span class="muted">还有 ${candidates.length - shown.length} 个，输入关键词缩小范围</span>`
            : '')
        : `<span class="muted">${q ? '没有匹配的消费对象' : '没有可添加的消费对象'}</span>`;
      wrap.querySelectorAll('[data-manage-add]').forEach(btn => btn.onclick = () => {
        addObjectToListFromManage(btn.dataset.manageAdd);
      });
    }

    async function addObjectToListFromManage(name) {
      const kind = specialListManageKey;
      if (!kind || !name) return;
      try {
        await addToCounterpartyList({kind, target_type: 'object', object_name: name});
        await reloadListDefs();
        $('status').textContent = `已把「${name}」加入${listLabelOf(kind)}`;
      } catch (err) {
        specialListMsg = err.message;
      }
      renderSpecialLists();
      renderCounterpartyView();
    }

    async function removeItemFromManage(itemId) {
      try {
        await removeFromCounterpartyList(Number(itemId));
        await reloadListDefs();
        $('status').textContent = '已从名单移除 1 条';
      } catch (err) {
        specialListMsg = err.message;
      }
      renderSpecialLists();
      renderCounterpartyView();
    }

    async function toggleListDefPin(key, nextPinned) {
      const def = listDefByKey(key);
      const name = def ? def.label : key;
      try {
        await api('/api/list-def-pin', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({key, pinned: nextPinned})
        });
        await reloadListDefs();
        specialListMsg = '';
        $('status').textContent = nextPinned ? `已置顶：${name}` : `已取消置顶：${name}`;
      } catch (err) {
        // 「最多置顶 3 个」等错误在这里显示，不静默失败
        specialListMsg = err.message;
      }
      renderSpecialLists();
      renderCounterpartyView();
    }

    if ($('specialListToggle')) $('specialListToggle').onclick = () => {
      specialListOpen = !specialListOpen;
      if (!specialListOpen) {
        specialListEditing = null;
        specialListDeleteKey = '';
        specialListManageKey = '';
        specialListManageQuery = '';
      }
      renderSpecialLists();
    };

    // ═══════════ 设置页：规则与筛选中台（修改分类 / 选择名单 默认收起）═══════════
    function renderCategoryHub() {
      const toggle = $('categoryHubToggle');
      const body = $('categoryHubBody');
      if (toggle) {
        toggle.setAttribute('aria-expanded', categoryHubOpen ? 'true' : 'false');
        toggle.classList.toggle('is-open', categoryHubOpen);
        const arrow = toggle.querySelector('.settings-collapse-arrow');
        if (arrow) arrow.textContent = categoryHubOpen ? '▴' : '▾';
      }
      if (body) body.classList.toggle('hidden', !categoryHubOpen);
      if (categoryHubOpen) {
        try {
          renderCategoryEditor();
        } catch (err) {
          $('status').textContent = err.message;
        }
      }
    }

    if ($('categoryHubToggle')) $('categoryHubToggle').onclick = () => {
      categoryHubOpen = !categoryHubOpen;
      if (!categoryHubOpen) {
        $('status').textContent = '';
      }
      renderCategoryHub();
    };

    // ═══════════ 设置页：导入账单 ═══════════
    // 默认目录由服务端决定（BILL_IMPORT_DIR 环境变量，或 <程序目录>/账单导入）。
    // 这里留空 = 不预填本机路径，交给服务端兜底，避免把提示文案当成路径提交。
    const IMPORT_DIR_FALLBACK = '';

    function renderImportPanel() {
      const panel = $('importPanel');
      const openBtn = $('importOpenBtn');
      if (!panel) return;
      panel.classList.toggle('hidden', !importPanelOpen);
      if (openBtn) openBtn.textContent = importPanelOpen ? '收起' : '导入';
      if (importPanelOpen) {
        const input = $('importPath');
        if (input && !input.value.trim()) {
          const hint = $('importDefaultDirHint');
          const hintText = hint ? hint.textContent.trim() : '';
          // 只有真正的绝对路径才预填；提示文案（如「账单导入」）留给服务端兜底
          const looksAbsolute = /^[A-Za-z]:[\\/]/.test(hintText) || hintText.startsWith('/');
          input.value = looksAbsolute ? hintText : IMPORT_DIR_FALLBACK;
        }
      }
    }

    function importSetStatus(text, tone) {
      const el = $('importStatus');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'import-status ' + (tone === 'busy' ? 'is-busy' : tone === 'error' ? 'is-error' : 'muted');
    }

    // 「账户对应」：把账单里识别到的账户标识（微信昵称 / 支付宝账户 / 银行卡尾号）
    // 逐个对到一个本地账户。默认值是后端模糊匹配的结果，用户可以在下拉里改；
    // 改完点「确认导入」时把映射一起提交给 /api/import-execute。
    function importAccountSuggestions(res) {
      return Array.isArray(res.account_suggestions) ? res.account_suggestions : [];
    }

    function renderAccountSuggestionBlock(res) {
      const list = importAccountSuggestions(res);
      if (!list.length) return '';
      const accounts = [];
      list.forEach(s => (s.existing_accounts || []).forEach(a => {
        if (a && !accounts.includes(a)) accounts.push(a);
      }));
      const rows = list.map(s => {
        const ident = String(s.identifier || '');
        const current = String(s.suggested_local || s.suggested_new || '');
        const opts = accounts.map(a =>
          `<option value="${esc(a)}"${a === current ? ' selected' : ''}>${esc(a)}</option>`).join('');
        // 「新建：xxx」用同一份 value（干净账户名），靠 data-new 标记区分显示
        const newName = String(s.suggested_new || '');
        const newOpt = (newName && !accounts.includes(newName))
          ? `<option value="${esc(newName)}" data-new="1"${newName === current ? ' selected' : ''}>新建：${esc(newName)}</option>`
          : '';
        const exists = accounts.includes(current);
        return `<div class="imp-map-row">
          <div class="imp-map-label">
            <span class="imp-map-hint">${esc(s.hint || '')}</span>
            <b>「${esc(ident)}」</b>
            <span class="muted">${Number(s.entry_count) || 0} 条</span>
          </div>
          <select class="imp-map-select" data-ident="${esc(ident)}" aria-label="${esc(ident)} 对应的本地账户">${opts}${newOpt}</select>
          <span class="imp-map-status ${exists ? 'ok' : 'warn'}">${exists ? '✓ 已存在' : '⚠ 将新建'}</span>
        </div>`;
      }).join('');
      return `<div class="import-block-list import-account-map">
        <h4>账户对应 <span class="muted">识别到 ${list.length} 个账户，确认每笔流水归到哪个本地账户</span></h4>
        <div class="imp-map-list">${rows}</div>
      </div>`;
    }

    function bindImportAccountMap() {
      document.querySelectorAll('.imp-map-select').forEach(sel => {
        sel.onchange = () => {
          const row = sel.closest('.imp-map-row');
          const badge = row ? row.querySelector('.imp-map-status') : null;
          if (!badge) return;
          const exists = Array.from(sel.options)
            .some(o => o.value === sel.value && !o.dataset.new);
          badge.textContent = exists ? '✓ 已存在' : '⚠ 将新建';
          badge.className = 'imp-map-status ' + (exists ? 'ok' : 'warn');
        };
      });
    }

    // 收集当前下拉状态 → {"账单里的账户标识": "本地账户名"}
    function collectImportAccountMapping() {
      const map = {};
      document.querySelectorAll('.imp-map-select').forEach(sel => {
        const ident = String(sel.dataset.ident || '').trim();
        const value = String(sel.value || '').trim();
        if (ident && value) map[ident] = value;
      });
      return map;
    }

    function renderImportResult(res, executed) {
      const box = $('importResult');
      if (!box) return;
      const files = (res.files || []).map(f =>
        `<li>${esc(f.source)} · ${esc(f.name)} · ${f.rows} 条 · ${esc(f.start || '')} ~ ${esc(f.end || '')}</li>`).join('');
      const newAcc = (res.new_accounts || []).map(a =>
        `<li>${esc(a.name)} · ${a.count} 条 · ${esc(a.amount)} 元（导入时自动新建，期初 0）</li>`).join('');
      const warns = (res.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
      const kpis = executed
        ? `<div class="imp-kpi"><b>${res.inserted}</b><span>实际写入</span></div>
           <div class="imp-kpi"><b>${res.failed || 0}</b><span>失败</span></div>
           <div class="imp-kpi"><b>${res.db_count_before} → ${res.db_count_after}</b><span>账目总数</span></div>
           <div class="imp-kpi"><b>${res.already_in_db || 0}</b><span>账本已有跳过</span></div>`
        : `<div class="imp-kpi"><b>${res.file_count}</b><span>识别文件</span></div>
           <div class="imp-kpi"><b>${res.raw_total}</b><span>解析原始条数</span></div>
           <div class="imp-kpi"><b>${res.dedup_total}</b><span>去重后条数</span></div>
           <div class="imp-kpi"><b>${res.already_in_db}</b><span>账本已有（跳过）</span></div>
           <div class="imp-kpi"><b>${res.to_insert}</b><span>将新增</span></div>`;
      const mapBlock = executed ? '' : renderAccountSuggestionBlock(res);
      const actions = executed
        ? `<div class="import-actions"><span class="muted">已写入 ${res.inserted} 条，请去「待确认」页逐条确认分类；数据库已自动备份。</span></div>`
        : (Number(res.to_insert) > 0
          ? `<div class="import-actions">
               <button class="primary" id="importExecuteBtn" type="button">确认导入 ${res.to_insert} 条</button>
               <span class="muted">点确认后先自动备份数据库再写入，新账目进入待确认。</span>
             </div>`
          : `<div class="import-actions"><span class="muted">没有需要新增的账目：这些文件的内容账本里都已存在。</span></div>`);
      box.innerHTML = `
        <div class="import-summary">${kpis}</div>
        ${files ? `<div class="import-block-list"><h4>识别到的文件</h4><ul>${files}</ul></div>` : ''}
        ${mapBlock}
        ${newAcc ? `<div class="import-block-list"><h4>将新建的账户</h4><ul>${newAcc}</ul></div>` : ''}
        ${warns ? `<div class="import-block-list import-warn"><h4>注意</h4><ul>${warns}</ul></div>` : ''}
        ${actions}`;
      box.classList.remove('hidden');
      bindImportAccountMap();
      const execBtn = $('importExecuteBtn');
      if (execBtn) execBtn.onclick = () => runImportExecute();
    }

    async function runImportPreview() {
      if (importBusy) return;
      const input = $('importPath');
      const path = input ? input.value.trim() : '';
      const btn = $('importPreviewBtn');
      const box = $('importResult');
      importBusy = true;
      if (btn) btn.disabled = true;
      if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
      importSetStatus('正在扫描并解析账单……（银行 PDF 需要几秒，期间不会改账本）', 'busy');
      try {
        const res = await api('/api/import-preview', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({path})
        });
        importPreviewData = res;
        if (input && res.source_dir) input.value = res.source_dir;
        renderImportResult(res, false);
        importSetStatus(`预览完成（${((res.elapsed_ms || 0) / 1000).toFixed(1)} 秒）—— 还没有写入任何账目`, 'ok');
      } catch (err) {
        importSetStatus('预览失败：' + err.message, 'error');
      } finally {
        importBusy = false;
        if (btn) btn.disabled = false;
      }
    }

    async function runImportExecute() {
      if (importBusy) return;
      const data = importPreviewData;
      if (!data) return;
      const n = Number(data.to_insert) || 0;
      if (!n) return;
      // 「账户对应」里用户改过的映射，跟着一起提交（用户改过的优先）
      const mapping = collectImportAccountMapping();
      const mapCount = Object.keys(mapping).length;
      const ok = window.confirm(
        `确认导入 ${n} 条新账目？\n\n`
        + '· 导入前会自动备份数据库\n'
        + '· 新账目状态为「待确认」，分类留空\n'
        + (mapCount ? `· 按「账户对应」的 ${mapCount} 条映射决定账户归属\n` : '')
        + '· 不会修改或删除任何已有账目');
      if (!ok) return;
      const input = $('importPath');
      const path = input ? input.value.trim() : '';
      const btn = $('importPreviewBtn');
      importBusy = true;
      if (btn) btn.disabled = true;
      importSetStatus(`正在导入 ${n} 条……（先备份数据库，再写入）`, 'busy');
      try {
        const res = await api('/api/import-execute', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({path, preview_only: false, account_mapping: mapping})
        });
        importPreviewData = res;
        renderImportResult(res, true);
        importSetStatus(`导入完成：写入 ${res.inserted || 0} 条，账目 ${res.db_count_before} → ${res.db_count_after}。请到「待确认」页处理。`, 'ok');
        await refresh();
      } catch (err) {
        importSetStatus('导入失败：' + err.message, 'error');
      } finally {
        importBusy = false;
        if (btn) btn.disabled = false;
      }
    }

    if ($('importOpenBtn')) $('importOpenBtn').onclick = () => {
      importPanelOpen = !importPanelOpen;
      renderImportPanel();
    };
    if ($('importPreviewBtn')) $('importPreviewBtn').onclick = () => runImportPreview();

    async function addToCounterpartyList(payload) {
      await api('/api/counterparty-list-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload)
      });
      await reloadCounterpartyLists();
    }

    async function removeFromCounterpartyList(id) {
      await api('/api/counterparty-list-delete', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({id})
      });
      await reloadCounterpartyLists();
    }

    async function toggleObjectInList(kind, name) {
      const existing = listItems(kind).find(item => item.target_type === 'object' && item.object_name === name);
      if (existing) await removeFromCounterpartyList(existing.id);
      else await addToCounterpartyList({kind, target_type: 'object', object_name: name});
      renderCounterpartyView();
    }

    async function addEntryToList(kind, entryId) {
      const row = entries.find(item => Number(item.id) === Number(entryId));
      const label = row ? `${row.transaction_time} · ${counterpartyNameOf(row)}` : `账目 #${entryId}`;
      await addToCounterpartyList({
        kind,
        target_type: 'entry',
        entry_id: entryId,
        object_name: row ? counterpartyNameOf(row) : '',
        label
      });
      $('status').textContent = `已加入${listLabelOf(kind)}`;
      renderCounterpartyView();
    }

    function bindCounterpartyEvents() {
      const wrap = $('counterpartyView');
      if (!wrap) return;
      wrap.querySelectorAll('[data-cp-label]').forEach(el => el.onclick = (event) => {
        if (event.target.closest('[data-cp-hide]') || event.target.closest('[data-cp-jump]')) return;
        const kind = el.dataset.cpLabel;
        cpMenuOpen = cpMenuOpen === kind ? '' : kind;
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-hide]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        const kind = btn.dataset.cpHide;
        if (cpHiddenKinds.has(kind)) cpHiddenKinds.delete(kind);
        else cpHiddenKinds.add(kind);
        cpMenuOpen = '';
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-new-slot]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        openNewListDialog({autoPin: true});
      });
      wrap.querySelectorAll('[data-cp-jump]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        cpPanel = btn.dataset.cpJump;
        cpPanelEdit = false;
        cpMenuOpen = '';
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-mode]').forEach(btn => btn.onclick = () => {
        cpMode = btn.dataset.cpMode;
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-col-sort]').forEach(th => th.onclick = () => {
        const field = th.dataset.cpColSort;
        if (cpSort === field) cpSortAsc = !cpSortAsc;
        else {
          cpSort = field;
          cpSortAsc = false;
          if (field !== 'count') cpAmountSort = field;
        }
        renderCounterpartyView();
      });
      const amountSelect = wrap.querySelector('#cpAmountSort');
      if (amountSelect) amountSelect.onchange = () => {
        cpAmountSort = amountSelect.value;
        cpSort = cpAmountSort;
        cpSortAsc = false;
        renderCounterpartyView();
      };
      const bindCpFilter = (id, key, after) => {
        const el = wrap.querySelector('#' + id);
        if (!el) return;
        el.onchange = () => {
          cpFilter[key] = String(el.value || '').trim();
          if (after) after();
          renderCounterpartyView();
        };
      };
      bindCpFilter('cpFilterMonth', 'month', () => { cpFilter.day = ''; });
      bindCpFilter('cpFilterDay', 'day');
      bindCpFilter('cpFilterMinCount', 'minCount');
      bindCpFilter('cpFilterMaxCount', 'maxCount');
      bindCpFilter('cpFilterMinAmount', 'minAmount');
      bindCpFilter('cpFilterMaxAmount', 'maxAmount');
      const cpClearBtn = wrap.querySelector('#cpClearFilters');
      if (cpClearBtn) cpClearBtn.onclick = () => {
        cpFilter = {month: '', day: '', minCount: '', maxCount: '', minAmount: '', maxAmount: ''};
        renderCounterpartyView();
      };
      wrap.querySelectorAll('[data-cp-object]').forEach(row => row.onclick = () => {
        counterpartyObject = row.dataset.cpObject;
        counterpartyMonth = '';
        cpDateFrom = '';
        cpDateTo = '';
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-back]').forEach(btn => btn.onclick = () => {
        cpPanel = '';
        counterpartyObject = '';
        cpPanelEdit = false;
        cpDateFrom = '';
        cpDateTo = '';
        renderCounterpartyView();
      });
      // 日期范围筛选（原来是月份 chips）：空 = 该对象最早 ~ 最晚流水
      const cpFromInput = wrap.querySelector('#cpDateFrom');
      if (cpFromInput) cpFromInput.onchange = () => {
        cpDateFrom = String(cpFromInput.value || '').slice(0, 10);
        renderCounterpartyView();
      };
      const cpToInput = wrap.querySelector('#cpDateTo');
      if (cpToInput) cpToInput.onchange = () => {
        cpDateTo = String(cpToInput.value || '').slice(0, 10);
        renderCounterpartyView();
      };
      wrap.querySelectorAll('[data-cp-date-reset]').forEach(btn => btn.onclick = () => {
        cpDateFrom = '';
        cpDateTo = '';
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-cp-toggle-whitelist]').forEach(btn => btn.onclick = () =>
        toggleObjectInList('whitelist', btn.dataset.cpToggleWhitelist).catch(err => $('status').textContent = err.message));
      wrap.querySelectorAll('[data-cp-toggle-large]').forEach(btn => btn.onclick = () =>
        toggleObjectInList('large', btn.dataset.cpToggleLarge).catch(err => $('status').textContent = err.message));
      wrap.querySelectorAll('[data-add-list]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        addEntryToList(btn.dataset.addList, btn.dataset.addEntry).catch(err => $('status').textContent = err.message);
      });
      wrap.querySelectorAll('[data-list-edit]').forEach(btn => btn.onclick = () => {
        cpPanelEdit = !cpPanelEdit;
        renderCounterpartyView();
      });
      wrap.querySelectorAll('[data-list-delete]').forEach(btn => btn.onclick = () =>
        removeFromCounterpartyList(btn.dataset.listDelete).then(renderCounterpartyView).catch(err => $('status').textContent = err.message));
      wrap.querySelectorAll('[data-list-save]').forEach(btn => btn.onclick = () => {
        const id = btn.dataset.listSave;
        const input = wrap.querySelector(`[data-list-note="${CSS.escape(String(id))}"]`);
        api('/api/counterparty-list-update', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id, note: input ? input.value : ''})
        }).then(reloadCounterpartyLists).then(renderCounterpartyView).catch(err => $('status').textContent = err.message);
      });
    }

    // ═══════════ 查看规则：分类规则 / 关键词规则 ═══════════
    function currentRulePanelType() {
      if (entryTypes.includes(rulePanelType)) return rulePanelType;
      return entryTypes.includes('支出') ? '支出' : (entryTypes[0] || '');
    }

    function keywordMatchCount(rule) {
      const keyword = String(rule.keyword || '');
      if (!keyword) return 0;
      return entries.filter(row =>
        String(row.transaction_object || '').includes(keyword) || String(row.note || '').includes(keyword)
      ).length;
    }

    async function reloadKeywordRules() {
      keywordRules = await api('/api/keyword-rules');
    }

    function renderKeywordRules() {
      const type = currentRulePanelType();
      rulePanelType = type;
      const groups = categoryTree[type] || {};
      const body = Object.keys(groups).map(group => {
        const leaves = groups[group] || [];
        if (!leaves.length) {
          return `<section class="category-editor-group">
            <div class="category-editor-head"><strong>${esc(group)}</strong><span class="muted">无小分类，可直接作为分类</span></div>
          </section>`;
        }
        const rows = leaves.map(leaf => {
          const category = categoryPath(group, leaf);
          const open = rulePanelLeaf === category;
          const rules = keywordRules.filter(rule => rule.category === category && (!rule.type || rule.type === type));
          const tags = rules.length
            ? rules.map(rule => `<span class="tag-chip">${esc(rule.keyword)}<span class="tag-count">${keywordMatchCount(rule)}</span>${rulePanelEdit ? `<button type="button" class="text-delete" data-kw-del="${esc(rule.id)}">×</button>` : ''}</span>`).join('')
            : '<span class="muted">还没有关键词</span>';
          return `<div class="list-row">
            <div class="list-main">
              <button type="button" class="chip picker-leaf" data-kw-leaf="${esc(category)}">${esc(leaf)}<span class="picker-count">${rules.length}</span></button>
              ${open ? `<div class="browser-leaves" style="margin-top:10px">${tags}${rulePanelEdit ? `<input class="tag-note" data-kw-new="${esc(category)}" placeholder="输入关键词后回车">` : ''}</div>` : ''}
            </div>
            ${open ? `<button type="button" class="${rulePanelEdit ? 'primary' : 'secondary'}" data-kw-edit="1">${rulePanelEdit ? '结束修改' : '修改'}</button>` : ''}
          </div>`;
        }).join('');
        return `<section class="category-editor-group">
          <div class="category-editor-head"><strong>${esc(group)}</strong><span class="muted">${leaves.length} 个小分类</span></div>
          <div>${rows}</div>
        </section>`;
      }).join('');
      return `${typeTabsHtml(type, 'kw-type')}${body || '<div class="muted">这个类型下还没有分类。先到「修改分类」里建。</div>'}`;
    }

    function renderRulePanel() {
      const panel = $('rulePanel');
      if (!panel || panel.classList.contains('hidden')) return;
      document.querySelectorAll('[data-rule-tab]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.ruleTab === rulePanelTab));
      const body = $('rulePanelBody');
      if (rulePanelTab === 'category') {
        const type = currentRulePanelType();
        body.innerHTML = `${typeTabsHtml(type, 'rule-type')}<div class="category-editor" id="rulePanelEditor">${categoryEditorHtml(type)}</div>`;
        body.querySelectorAll('[data-rule-type]').forEach(btn => btn.onclick = () => {
          rulePanelType = btn.dataset.ruleType;
          renderRulePanel();
        });
        bindCategoryEditor(body.querySelector('#rulePanelEditor'), type);
      } else {
        body.innerHTML = renderKeywordRules();
        body.querySelectorAll('[data-kw-type]').forEach(btn => btn.onclick = () => {
          rulePanelType = btn.dataset.kwType;
          rulePanelLeaf = '';
          rulePanelEdit = false;
          renderRulePanel();
        });
        body.querySelectorAll('[data-kw-leaf]').forEach(btn => btn.onclick = () => {
          rulePanelLeaf = rulePanelLeaf === btn.dataset.kwLeaf ? '' : btn.dataset.kwLeaf;
          rulePanelEdit = false;
          renderRulePanel();
        });
        body.querySelectorAll('[data-kw-edit]').forEach(btn => btn.onclick = () => {
          rulePanelEdit = !rulePanelEdit;
          renderRulePanel();
        });
        body.querySelectorAll('[data-kw-del]').forEach(btn => btn.onclick = () =>
          api('/api/keyword-rule-delete', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({id: Number(btn.dataset.kwDel)})
          }).then(reloadKeywordRules).then(renderRulePanel).catch(err => $('status').textContent = err.message));
        body.querySelectorAll('[data-kw-new]').forEach(input => {
          input.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            const keyword = input.value.trim();
            if (!keyword) return;
            api('/api/keyword-rule-add', {
              method: 'POST', headers: {'content-type': 'application/json'},
              body: JSON.stringify({keyword, category: input.dataset.kwNew, type: rulePanelType})
            }).then(reloadKeywordRules).then(renderRulePanel).catch(err => $('status').textContent = err.message);
          };
        });
      }
    }

    // ═══════════ 弹层与开关 ═══════════
    function openRulePanel(tab) {
      rulePanelTab = tab || 'category';
      rulePanelLeaf = '';
      rulePanelEdit = false;
      $('rulePanel').classList.remove('hidden');
      renderRulePanel();
    }

    function closeRulePanel() {
      $('rulePanel').classList.add('hidden');
    }

    if ($('openRulePanel')) $('openRulePanel').onclick = () => openRulePanel('category');
    if ($('closeRulePanel')) $('closeRulePanel').onclick = closeRulePanel;
    if ($('rulePanel')) {
      $('rulePanel').onclick = (event) => {
        if (event.target === $('rulePanel')) closeRulePanel();
      };
    }
    document.querySelectorAll('[data-rule-tab]').forEach(btn => btn.onclick = () => {
      rulePanelTab = btn.dataset.ruleTab;
      rulePanelLeaf = '';
      rulePanelEdit = false;
      renderRulePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('rulePanel') && !$('rulePanel').classList.contains('hidden')) closeRulePanel();
    });

    function bindAutoApplyToggle() {
      const toggle = $('autoApplyToggle');
      if (!toggle) return;
      toggle.checked = appSettings.auto_apply_rules !== false;
      toggle.onchange = async () => {
        try {
          await api('/api/settings', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({key: 'auto_apply_rules', value: toggle.checked})
          });
          appSettings.auto_apply_rules = toggle.checked;
          $('status').textContent = toggle.checked ? '自动归类：已开启' : '自动归类：已关闭';
        } catch (err) {
          $('status').textContent = err.message;
        }
      };
    }

    // ═══════════ 误选撤销：返回上一条 ═══════════
    function pushPendingHistory(item, category) {
      if (!item) return;
      pendingHistory.push({
        id: Number(item.id),
        object: String(item.transaction_object || '').trim(),
        category
      });
      if (pendingHistory.length > 20) pendingHistory.shift();
      updateUndoButton();
    }

    function updateUndoButton() {
      const btn = $('pendingUndoBtn');
      if (!btn) return;
      const last = pendingHistory[pendingHistory.length - 1];
      if (!last) {
        btn.disabled = true;
        btn.textContent = '← 返回上一条';
      } else {
        btn.disabled = false;
        btn.textContent = `← 返回上一条（${last.object || '未命名'} → ${categoryLabel(last.category)}）`;
      }
    }

    async function undoLastConfirm() {
      const last = pendingHistory.pop();
      updateUndoButton();
      if (!last) return;
      try {
        await api('/api/entry-revert', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id: last.id})
        });
        $('status').textContent = `已撤回：${last.object || '未命名'}（${categoryLabel(last.category)}）`;
        await refresh();
      } catch (err) {
        $('status').textContent = err.message;
      }
    }

    // ═══════════ 只改分类（所有列表通用） ═══════════
    function openCategoryQuickPick(entryId) {
      const row = entries.find(item => Number(item.id) === Number(entryId));
      if (!row) return;
      quickPickEntryId = Number(entryId);
      quickPickGroup = '';
      quickPickPickedCategory = '';
      const info = $('catQuickPickInfo');
      if (info) {
        info.innerHTML = `<span class="quick-pick-info">${esc(row.transaction_time || '')} · ${esc(row.type || '')} · ${esc(signedEntryMoney(row.amount_cents, row))} · ${esc(row.transaction_object || '')}　当前：<strong>${esc(categoryLabel(row.category) || '未分类')}</strong></span>`;
      }
      $('catQuickPick').classList.remove('hidden');
      renderCategoryQuickPick();
    }

    function renderCategoryQuickPick() {
      const row = entries.find(item => Number(item.id) === Number(quickPickEntryId));
      const body = $('catQuickPickBody');
      if (!row || !body) return;
      const groups = categoryTree[row.type] || {};
      const names = Object.keys(groups);
      if (!quickPickGroup || !names.includes(quickPickGroup)) quickPickGroup = names[0] || '';
      const picked = quickPickPickedCategory;
      const groupChips = names.map(name =>
        `<button type="button" class="chip picker-group${name === quickPickGroup ? ' is-active' : ''}" data-qp-group="${esc(name)}">${esc(name)}</button>`
      ).join('');
      const leaves = quickPickGroup ? (groups[quickPickGroup] || []) : [];
      const leafButtons = leaves.map(leaf => {
        const target = categoryPath(quickPickGroup, leaf);
        return `<button type="button" class="chip picker-leaf${picked === target ? ' is-picked' : ''}" data-qp-set="${esc(target)}">${esc(leaf)}</button>`;
      }).join('');
      const direct = quickPickGroup && !leaves.length
        ? (() => {
            const target = quickPickGroup;
            return `<button type="button" class="chip picker-leaf picker-direct${picked === target ? ' is-picked' : ''}" data-qp-set="${esc(target)}">直接用「${esc(quickPickGroup)}」</button>`;
          })()
        : '';
      const transferBtn = `<button type="button" class="chip picker-add${picked === '转账' ? ' is-picked' : ''}" data-qp-set="转账">标为「转账」——内部划转，计入余额但不计入收支统计</button>`;
      const confirmBar = picked
        ? `<div class="quick-pick-confirm">
             <span class="muted">已选：<strong>${esc(categoryLabel(picked) || picked)}</strong></span>
             <button type="button" class="primary" data-qp-confirm="1">确认修改</button>
             <button type="button" class="secondary" data-qp-cancel="1">取消</button>
           </div>`
        : '<div class="quick-pick-confirm muted">先选一个分类，再点「确认修改」——不会自动提交</div>';
      body.innerHTML = `
        <div class="category-picker">
          <div class="category-group">
            <div class="category-group-title">大分类（${esc(row.type || '')}）</div>
            <div class="category-group-options">${groupChips || '<span class="muted">这个类型下还没有大分类，去「设置 → 修改分类」建</span>'}</div>
          </div>
          <div class="category-group">
            <div class="category-group-title">小分类${quickPickGroup ? ` · ${esc(quickPickGroup)}` : ''}</div>
            <div class="category-group-options">${leaves.length ? (leafButtons || '<span class="muted">先选一个大分类</span>') : (direct || '<span class="muted">先选一个大分类</span>')}</div>
          </div>
          <div class="category-group">
            <div class="category-group-title">特殊标记</div>
            <div class="category-group-options">${transferBtn}</div>
          </div>
          ${confirmBar}
        </div>`;
      body.querySelectorAll('[data-qp-group]').forEach(btn => btn.onclick = () => {
        quickPickGroup = btn.dataset.qpGroup;
        renderCategoryQuickPick();
      });
      body.querySelectorAll('[data-qp-set]').forEach(btn => btn.onclick = () => {
        quickPickPickedCategory = btn.dataset.qpSet;
        renderCategoryQuickPick();
      });
      const confirmBtn = body.querySelector('[data-qp-confirm]');
      if (confirmBtn) confirmBtn.onclick = () => { confirmCategoryQuickPick(); };
      const cancelBtn = body.querySelector('[data-qp-cancel]');
      if (cancelBtn) cancelBtn.onclick = () => {
        quickPickPickedCategory = '';
        renderCategoryQuickPick();
      };
    }

    async function confirmCategoryQuickPick() {
      const id = Number(quickPickEntryId);
      const category = quickPickPickedCategory;
      if (!id || !category) return;
      const row = entries.find(item => Number(item.id) === id);
      const fromCategory = row ? String(row.category || '') : '';
      const fromStatus = row ? String(row.status || '') : '';
      $('catQuickPick').classList.add('hidden');
      quickPickEntryId = null;
      const picked = category;
      quickPickPickedCategory = '';
      if (row && fromCategory === picked) {
        // 分类没变：不提交、也不弹撤销提示
        $('status').textContent = `分类未变化：${categoryLabel(picked) || picked}`;
        return;
      }
      try {
        await api('/api/entry-category', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id, category: picked})
        });
        await refresh();
        $('status').textContent = `已改分类：${categoryLabel(picked) || picked}`;
        showCategoryUndoToast({id, fromCategory, fromStatus, toCategory: picked});
      } catch (err) {
        $('status').textContent = err.message;
      }
    }

    if ($('pendingUndoBtn')) $('pendingUndoBtn').onclick = () => undoLastConfirm();
    if ($('closeCatQuickPick')) $('closeCatQuickPick').onclick = () => {
      $('catQuickPick').classList.add('hidden');
      quickPickEntryId = null;
      quickPickPickedCategory = '';
    };
    if ($('catQuickPick')) $('catQuickPick').onclick = (event) => {
      if (event.target === $('catQuickPick')) {
        $('catQuickPick').classList.add('hidden');
        quickPickEntryId = null;
        quickPickPickedCategory = '';
      }
    };

    // ═══════════ 按对象批量确认 ═══════════
    // ── 单条「暂时隐藏」：只存 localStorage，不改分类、不动数据 ──
    function readBatchHiddenKeys() {
      try {
        const raw = JSON.parse(localStorage.getItem('bookkeeping.batchHiddenEntries') || '[]');
        return new Set(Array.isArray(raw) ? raw.map(String) : []);
      } catch (err) {
        return new Set();
      }
    }

    function saveBatchHiddenKeys() {
      localStorage.setItem('bookkeeping.batchHiddenEntries', JSON.stringify([...batchHiddenIds]));
    }

    // 待确认列表的 id 在 entries / unconfirmed_entries 两张表可能重号，用 ui_id 当键更稳
    function batchEntryKey(item) {
      if (!item) return '';
      const raw = (item.ui_id === undefined || item.ui_id === null || item.ui_id === '') ? item.id : item.ui_id;
      return String(raw === undefined || raw === null ? '' : raw);
    }

    function batchObjectName(item) {
      return String(item && item.transaction_object || '').trim() || '（空）';
    }

    function batchHiddenItems(scope = '') {
      return pendingItems
        .filter(item => batchHiddenIds.has(batchEntryKey(item)))
        .filter(item => !scope || batchObjectName(item) === scope)
        .sort((a, b) => String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
    }

    function hideBatchEntry(key) {
      const item = pendingItems.find(it => batchEntryKey(it) === key);
      batchHiddenIds.add(key);
      saveBatchHiddenKeys();
      if (item) batchSelected.delete(Number(item.id));
      $('status').textContent = `已隐藏 1 条${item ? `（${item.transaction_time || ''} · ${signedMoney(Number(item.amount_cents) || 0, moneyTone(item))}）` : ''}，分类和数据都没动`;
      renderPendingBatch();
    }

    function restoreBatchEntry(key) {
      batchHiddenIds.delete(key);
      saveBatchHiddenKeys();
      $('status').textContent = '已恢复 1 条';
      renderPendingBatch();
    }

    function bindBatchViewEvents(wrap) {
      wrap.querySelectorAll('[data-batch-expand]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        batchDetailObject = btn.dataset.batchExpand;
        batchView = 'detail';
        renderPendingBatch();
      });
      wrap.querySelectorAll('[data-batch-back]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        const target = btn.dataset.batchBack;
        if (target === 'detail') {
          batchView = 'detail';
        } else {
          batchView = 'groups';
          batchDetailObject = '';
        }
        batchHiddenScope = '';
        renderPendingBatch();
      });
      wrap.querySelectorAll('[data-batch-show-hidden]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        batchHiddenScope = btn.dataset.batchShowHidden === 'all' ? '' : batchDetailObject;
        batchView = 'hidden';
        renderPendingBatch();
      });
      wrap.querySelectorAll('[data-batch-hide]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        hideBatchEntry(btn.dataset.batchHide);
      });
      wrap.querySelectorAll('[data-batch-restore]').forEach(btn => btn.onclick = (event) => {
        event.stopPropagation();
        restoreBatchEntry(btn.dataset.batchRestore);
      });
    }

    function batchFilteredPending() {
      const min = batchFilter.min === '' ? null : Math.round(Number(batchFilter.min) * 100);
      const max = batchFilter.max === '' ? null : Math.round(Number(batchFilter.max) * 100);
      return pendingItems.filter(item => {
        // 被「暂时隐藏」的条目不再参与批量勾选 / 归属
        if (batchHiddenIds.has(batchEntryKey(item))) return false;
        const amount = Number(item.amount_cents) || 0;
        if (min !== null && !Number.isNaN(min) && amount < min) return false;
        if (max !== null && !Number.isNaN(max) && amount > max) return false;
        const day = String(item.transaction_time || '').slice(0, 10);
        if (batchFilter.from && day < batchFilter.from) return false;
        if (batchFilter.to && day > batchFilter.to) return false;
        return true;
      });
    }

    function batchGroups() {
      const map = new Map();
      batchFilteredPending().forEach(item => {
        const name = String(item.transaction_object || '').trim() || '（空）';
        if (!map.has(name)) map.set(name, {name, items: [], total: 0, tone: 'expense'});
        const group = map.get(name);
        group.items.push(item);
        group.total += Number(item.amount_cents) || 0;
        if (moneyTone(item) === 'income') group.tone = 'income';
      });
      const groups = [...map.values()];
      if (batchFilter.sort === 'amount') groups.sort((a, b) => b.total - a.total);
      else if (batchFilter.sort === 'time') {
        groups.sort((a, b) => String(b.items[0].transaction_time || '').localeCompare(String(a.items[0].transaction_time || '')));
      } else groups.sort((a, b) => b.items.length - a.items.length);
      return groups;
    }

    function batchCategoryOptionsHtml() {
      const seen = new Set();
      const out = [];
      pendingItems.forEach(item => {
        categoriesForType(item.type).forEach(cat => {
          if (seen.has(cat)) return;
          seen.add(cat);
          out.push(`<option value="${esc(cat)}">${esc(categoryLabel(cat))}</option>`);
        });
      });
      out.push('<option value="转账">转账（内部划转，不计入收支统计）</option>');
      return out.join('') || '<option value="">（还没有分类）</option>';
    }

    function setPendingBatchMode(on) {
      pendingBatchMode = on;
      if (on) {
        batchView = 'groups';
        batchDetailObject = '';
        batchHiddenScope = '';
      }
      if ($('pendingBatch')) $('pendingBatch').classList.toggle('hidden', !on);
      if ($('pendingList')) $('pendingList').classList.toggle('hidden', on);
      if ($('pendingBatchBtn')) {
        $('pendingBatchBtn').textContent = on ? '← 返回卡片视图' : '按对象批量';
        $('pendingBatchBtn').classList.toggle('primary', on);
      }
      if (on) renderPendingBatch();
      else renderPending();
    }

    if ($('pendingBatchBtn')) $('pendingBatchBtn').onclick = () => setPendingBatchMode(!pendingBatchMode);

    function renderPendingBatch() {
      const wrap = $('pendingBatch');
      if (!wrap) return;
      if (batchView === 'detail') {
        renderPendingBatchDetail(wrap);
        return;
      }
      if (batchView === 'hidden') {
        renderPendingBatchHidden(wrap);
        return;
      }
      renderPendingBatchGroups(wrap);
    }

    // 单个交易对象在当前筛选下的明细（复用交互消费统计详情页的呈现方式）
    function renderPendingBatchDetail(wrap) {
      const name = batchDetailObject;
      const rows = batchFilteredPending()
        .filter(item => batchObjectName(item) === name)
        .sort((a, b) => String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
      const hiddenRows = batchHiddenItems(name);
      const expense = rows.filter(item => moneyTone(item) !== 'income').reduce((sum, item) => sum + (Number(item.amount_cents) || 0), 0);
      const income = rows.filter(item => moneyTone(item) === 'income').reduce((sum, item) => sum + (Number(item.amount_cents) || 0), 0);
      const body = rows.map(item => `
        <tr>
          <td>${esc(item.transaction_time || '')}</td>
          <td>${esc(item.type || '')}</td>
          <td class="money-cell">${esc(signedMoney(Number(item.amount_cents) || 0, moneyTone(item)))}</td>
          <td>${esc(categoryLabel(item.category) || '未分类')}</td>
          <td>${esc(item.account || '')}</td>
          <td>${esc(item.note || '')}</td>
          <td class="batch-detail-actions">
            <button type="button" class="secondary" data-batch-hide="${esc(batchEntryKey(item))}">隐藏</button>
            ${item.source && item.source !== 'pending' ? '' : `<button type="button" class="cat-edit-btn" data-cat-edit="${esc(item.id)}">改分类</button>`}
          </td>
        </tr>`).join('');
      wrap.innerHTML = `
        <div class="browser-bar">
          <button type="button" class="secondary" data-batch-back="groups">← 返回按对象批量</button>
          <span class="browser-path">${esc(name)}</span>
          <button type="button" class="secondary" data-batch-show-hidden="1">查看隐藏的条目${hiddenRows.length ? `（${hiddenRows.length}）` : ''}</button>
          <span class="muted">当前筛选下可见 ${rows.length} 笔${hiddenRows.length ? ` · 已隐藏 ${hiddenRows.length} 笔` : ''}</span>
        </div>
        <div class="entry-controls"><div class="muted">支出 ${esc(signedMoney(expense, 'expense'))} · 收入 ${esc(signedMoney(income, 'income'))}</div></div>
        <table class="plain-table">
          <thead><tr><th>时间</th><th>类型</th><th>金额</th><th>分类</th><th>账户</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${body || '<tr><td colspan="7" class="muted">这个对象在当前筛选下没有可见条目</td></tr>'}</tbody>
        </table>`;
      bindBatchViewEvents(wrap);
    }

    // 隐藏的条目：从对象详情进来只看本对象，从批量界面进来列出全部并标注「（隐藏）」
    function renderPendingBatchHidden(wrap) {
      const scope = batchHiddenScope;
      const rows = batchHiddenItems(scope);
      const body = rows.map(item => `
        <tr>
          <td>${esc(batchObjectName(item))}<span class="muted">（隐藏）</span></td>
          <td>${esc(item.transaction_time || '')}</td>
          <td>${esc(item.type || '')}</td>
          <td class="money-cell">${esc(signedMoney(Number(item.amount_cents) || 0, moneyTone(item)))}</td>
          <td>${esc(categoryLabel(item.category) || '未分类')}</td>
          <td><button type="button" class="secondary" data-batch-restore="${esc(batchEntryKey(item))}">恢复</button></td>
        </tr>`).join('');
      wrap.innerHTML = `
        <div class="browser-bar">
          <button type="button" class="secondary" data-batch-back="${scope ? 'detail' : 'groups'}">← 返回${scope ? esc(scope) : '按对象批量'}</button>
          <span class="browser-path">隐藏的条目${scope ? ` · ${esc(scope)}` : ''}</span>
          <span class="muted">${rows.length} 笔 · 只是暂时不显示，分类和数据都没改</span>
        </div>
        <table class="plain-table">
          <thead><tr><th>交易对象</th><th>时间</th><th>类型</th><th>金额</th><th>分类</th><th>操作</th></tr></thead>
          <tbody>${body || '<tr><td colspan="6" class="muted">没有隐藏的条目</td></tr>'}</tbody>
        </table>`;
      bindBatchViewEvents(wrap);
    }

    function renderPendingBatchGroups(wrap) {
      const items = batchFilteredPending();
      const groups = batchGroups();
      const catOptions = batchCategoryOptionsHtml();
      const hiddenCount = batchHiddenItems('').length;
      const rows = groups.map(group => {
        const allSel = group.items.every(it => batchSelected.has(Number(it.id)));
        const cats = [...new Set(group.items.map(it => categoryLabel(it.category) || '未分类'))].slice(0, 2).join(' / ');
        return `<tr class="batch-row${allSel ? ' is-selected' : ''}" data-batch-group="${esc(group.name)}">
          <td class="batch-check">${allSel ? '☑' : '☐'}</td>
          <td>${esc(group.name)}</td>
          <td class="num-cell">${group.items.length}</td>
          <td class="money-cell">${esc(signedMoney(group.total, group.tone))}</td>
          <td>${esc(cats)}</td>
          <td class="batch-expand-cell"><button type="button" class="batch-expand-btn" data-batch-expand="${esc(group.name)}" title="展开这个对象的明细">＞</button></td>
        </tr>`;
      }).join('');
      wrap.innerHTML = `
        <div class="batch-filters">
          <label>金额 ≥<input id="batchMin" type="number" step="0.01" placeholder="不限" value="${esc(batchFilter.min)}"></label>
          <label>金额 ≤<input id="batchMax" type="number" step="0.01" placeholder="不限" value="${esc(batchFilter.max)}"></label>
          <label>起始日<input id="batchFrom" type="date" value="${esc(batchFilter.from)}"></label>
          <label>截止日<input id="batchTo" type="date" value="${esc(batchFilter.to)}"></label>
          <label>排序<select id="batchSort">
            <option value="count"${batchFilter.sort === 'count' ? ' selected' : ''}>按笔数</option>
            <option value="amount"${batchFilter.sort === 'amount' ? ' selected' : ''}>按金额</option>
            <option value="time"${batchFilter.sort === 'time' ? ' selected' : ''}>按时间</option>
          </select></label>
          <div class="batch-actions"><button class="secondary" id="batchShowHidden" type="button">查看隐藏的条目${hiddenCount ? `（${hiddenCount}）` : ''}</button><button class="secondary" id="batchClearFilter" type="button">清空筛选</button></div>
        </div>
        <div class="entry-controls"><div class="muted">筛选后 <strong>${items.length}</strong> 笔，分属 <strong>${groups.length}</strong> 个交易对象；点一行整组选中${hiddenCount ? ` · 已隐藏 ${hiddenCount} 笔` : ''}</div></div>
        <table class="plain-table">
          <thead><tr><th class="batch-check">选</th><th>交易对象</th><th>笔数</th><th>金额合计</th><th>当前分类</th><th class="batch-expand-head">展开</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">没有符合筛选条件的条目</td></tr>'}</tbody>
        </table>
        <div class="batch-apply">
          <span>已选 <strong>${batchSelected.size}</strong> 笔</span>
          <select id="batchCategory">${catOptions}</select>
          <button class="primary" id="batchApply" type="button">批量确认</button>
          <button class="secondary" id="batchSelectAll" type="button">全选当前结果</button>
          <button class="secondary" id="batchClearSel" type="button">清空选择</button>
        </div>`;
      const syncFilter = () => {
        batchFilter.min = $('batchMin').value;
        batchFilter.max = $('batchMax').value;
        batchFilter.from = $('batchFrom').value;
        batchFilter.to = $('batchTo').value;
        batchFilter.sort = $('batchSort').value;
        renderPendingBatch();
      };
      ['batchMin', 'batchMax', 'batchFrom', 'batchTo', 'batchSort'].forEach(id => {
        if ($(id)) $(id).onchange = syncFilter;
      });
      $('batchClearFilter').onclick = () => {
        batchFilter = {min: '', max: '', from: '', to: '', sort: 'count'};
        batchSelected.clear();
        renderPendingBatch();
      };
      if ($('batchShowHidden')) $('batchShowHidden').onclick = () => {
        batchHiddenScope = '';
        batchView = 'hidden';
        renderPendingBatch();
      };
      bindBatchViewEvents(wrap);
      wrap.querySelectorAll('[data-batch-group]').forEach(tr => tr.onclick = () => {
        const group = groups.find(g => g.name === tr.dataset.batchGroup);
        if (!group) return;
        const allSel = group.items.every(it => batchSelected.has(Number(it.id)));
        group.items.forEach(it => {
          if (allSel) batchSelected.delete(Number(it.id));
          else batchSelected.add(Number(it.id));
        });
        renderPendingBatch();
      });
      $('batchSelectAll').onclick = () => {
        items.forEach(it => batchSelected.add(Number(it.id)));
        renderPendingBatch();
      };
      $('batchClearSel').onclick = () => {
        batchSelected.clear();
        renderPendingBatch();
      };
      $('batchApply').onclick = async () => {
        const category = $('batchCategory').value;
        if (!category || !batchSelected.size) return;
        if (!confirm(`把选中的 ${batchSelected.size} 笔全部归到「${categoryLabel(category)}」？`)) return;
        const ids = [...batchSelected];
        try {
          const res = await api('/api/batch-confirm', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({ids, category})
          });
          batchSelected.clear();
          await refresh();
          $('status').textContent = `批量确认完成：成功 ${res.ok} 笔` + (res.failed && res.failed.length ? `，失败 ${res.failed.length} 笔` : '');
        } catch (err) {
          $('status').textContent = err.message;
        }
      };
    }

    // 全局委托：任何列表里的「改分类」按钮
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-cat-edit]');
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      openCategoryQuickPick(btn.dataset.catEdit);
    }, true);

    refresh().catch(err => $('status').textContent = err.message);
