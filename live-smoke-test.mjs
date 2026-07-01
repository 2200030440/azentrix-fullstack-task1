const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333';
const LIVE_URL = process.env.TEST_URL || 'https://taupe-khapse-e57086.netlify.app/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function createPageTarget(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  });
  if (!response.ok) {
    throw new Error(`Failed to create tab: ${response.status}`);
  }
  return response.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();

    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(client, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await evaluate(client, expression);
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result.value;
}

async function click(client, selector) {
  await evaluate(client, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing selector: ${selector}');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const options = { bubbles: true, cancelable: true, composed: true };
      el.dispatchEvent(new MouseEvent('pointerdown', options));
      el.dispatchEvent(new MouseEvent('pointerup', options));
      el.dispatchEvent(new MouseEvent('click', options));
      return true;
    })()
  `);
}

async function clickCenter(client, selector) {
  const rect = await evaluate(client, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing selector: ${selector}');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height
      };
    })()
  `);

  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  });
}

async function setValue(client, selector, value) {
  await evaluate(client, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing selector: ${selector}');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

async function readState(client) {
  return evaluate(client, `
    (() => ({
      transactions: JSON.parse(localStorage.getItem('aurabudget_transactions') || '[]'),
      budgetLimit: localStorage.getItem('aurabudget_budget_limit'),
      alertThreshold: localStorage.getItem('aurabudget_alert_threshold'),
      currency: localStorage.getItem('aurabudget_currency'),
      visibleRows: document.querySelectorAll('#fullTransactionsTableBody tr').length,
      emptyVisible: getComputedStyle(document.querySelector('#tableEmptyState')).display !== 'none',
      confirmActive: document.querySelector('#confirmModal').classList.contains('active'),
      activeTab: document.querySelector('.nav-link.active')?.textContent?.trim()
    }))()
  `);
}

async function readClickDebug(client, selector) {
  return evaluate(client, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { exists: false };
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        exists: true,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        disabled: !!el.disabled,
        html: el.outerHTML,
        topTag: top?.tagName,
        topClasses: top?.className,
        topHtml: top?.outerHTML?.slice(0, 300),
        confirmActive: document.querySelector('#confirmModal').classList.contains('active')
      };
    })()
  `);
}

async function main() {
  await getJson(`${CDP}/json/version`);
  const target = await createPageTarget('about:blank');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });
  await client.send('Page.navigate', { url: LIVE_URL });
  await waitFor(client, `document.readyState === 'complete' && !!document.querySelector('#btnOpenAddModal')`, 20000);
  await sleep(1500);

  await evaluate(client, `localStorage.clear(); location.reload(); true`);
  await sleep(2500);
  await waitFor(client, `document.readyState === 'complete' && !!document.querySelector('#btnOpenAddModal')`, 20000);

  const initial = await readState(client);

  await clickCenter(client, '#btnOpenAddModal');
  await waitFor(client, `document.querySelector('#transactionModal').classList.contains('active')`);
  await setValue(client, '#txAmount', '123.45');
  await setValue(client, '#txDate', '2026-06-30');
  await setValue(client, '#txDescription', 'Live smoke delete test');
  await setValue(client, '#txNotes', 'temporary automated test');
  await clickCenter(client, '#btnSubmitForm');
  await waitFor(client, `JSON.parse(localStorage.getItem('aurabudget_transactions') || '[]').length === 1`);
  await waitFor(client, `!document.querySelector('#transactionModal').classList.contains('active')`);
  const afterAdd = await readState(client);

  await clickCenter(client, '#navTransactions');
  await waitFor(client, `document.querySelector('.nav-link.active')?.textContent?.includes('Transactions')`);
  await waitFor(client, `document.querySelectorAll('#fullTransactionsTableBody .delete-btn').length === 1`);
  const beforeDeleteClick = await readClickDebug(client, '#fullTransactionsTableBody .delete-btn');
  await evaluate(client, `(() => {
      const btn = document.querySelector('#fullTransactionsTableBody .delete-btn');
      if (!btn) throw new Error('Missing delete button');
      btn.click();
      return true;
    })()`);
  await sleep(500);
  let deleteClicked = await evaluate(client, `document.querySelector('#confirmModal').classList.contains('active')`);
  const afterDeleteMouseClick = await readClickDebug(client, '#fullTransactionsTableBody .delete-btn');
  if (!deleteClicked) {
    await evaluate(client, `(() => {
      const btn = document.querySelector('#fullTransactionsTableBody .delete-btn');
      if (!btn) throw new Error('Missing delete button');
      btn.click();
      return true;
    })()`);
    await sleep(500);
    deleteClicked = await evaluate(client, `document.querySelector('#confirmModal').classList.contains('active')`);
  }
  if (!deleteClicked) {
    throw new Error(`Delete confirm did not open: ${JSON.stringify({ beforeDeleteClick, afterDeleteMouseClick })}`);
  }
  const deleteModal = await readState(client);
  await clickCenter(client, '#btnApproveConfirm');
  await waitFor(client, `JSON.parse(localStorage.getItem('aurabudget_transactions') || '[]').length === 0`);
  const afterDelete = await readState(client);

  await clickCenter(client, '#btnOpenAddModal');
  await waitFor(client, `document.querySelector('#transactionModal').classList.contains('active')`);
  await setValue(client, '#txAmount', '777');
  await setValue(client, '#txDate', '2026-06-30');
  await setValue(client, '#txDescription', 'Live smoke reset test');
  await clickCenter(client, '#btnSubmitForm');
  await waitFor(client, `JSON.parse(localStorage.getItem('aurabudget_transactions') || '[]').length === 1`);
  await waitFor(client, `!document.querySelector('#transactionModal').classList.contains('active')`);

  await clickCenter(client, '#navBudgetSettings');
  await waitFor(client, `document.querySelector('.nav-link.active')?.textContent?.includes('Budget')`);
  await setValue(client, '#inputBudgetLimit', '999');
  await evaluate(client, `document.querySelector('#budgetSettingsForm').requestSubmit(); true`);
  await waitFor(client, `localStorage.getItem('aurabudget_budget_limit') === '999'`);
  const beforeReset = await readState(client);

  await clickCenter(client, '#btnResetData');
  await waitFor(client, `document.querySelector('#confirmModal').classList.contains('active')`);
  const resetModal = await readState(client);
  await clickCenter(client, '#btnApproveConfirm');
  await waitFor(client, `JSON.parse(localStorage.getItem('aurabudget_transactions') || '[]').length === 0 && localStorage.getItem('aurabudget_budget_limit') === '1200'`);
  const afterReset = await readState(client);

  await evaluate(client, `localStorage.clear(); true`);
  client.close();

  console.log(JSON.stringify({
    initial,
    afterAdd,
    deleteModal,
    afterDelete,
    beforeReset,
    resetModal,
    afterReset
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
