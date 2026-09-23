import axios from 'axios';
import https from 'node:https';

const normalizeToken = (token) => (token.startsWith('Basic ') ? token : `Basic ${token}`);

const dataRows = (response) => {
  const data = response?.data;
  if (Array.isArray(data?.registros)) return data.registros;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
};

const parsePhpSerializedMap = (value) => {
  const decoded = Buffer.from(String(value), 'base64').toString('utf8');
  const fields = {};
  const pattern = /s:\d+:"([^"]+)";(?:s:\d+:"([^"]*)"|i:(\d+));/g;

  for (const match of decoded.matchAll(pattern)) {
    fields[match[1]] = match[2] ?? match[3] ?? '';
  }

  return fields;
};

const normalizePendingOnu = (row) => {
  if (!Array.isArray(row?.cell)) return row;

  let fields = {};
  try {
    fields = parsePhpSerializedMap(row.id);
  } catch {
    fields = {};
  }

  const [oltName, chassi, slot, pon, model, mac] = row.cell;
  return {
    id: row.id,
    fila_id: fields.ID ?? '',
    id_olt: fields.ID ?? '',
    olt_nome: oltName ?? '',
    Chassi: fields.CHASSI ?? chassi ?? '',
    slotno: fields.SLO ?? slot ?? '',
    ponno: fields.PON ?? pon ?? '',
    ponid: fields.PONID ?? '',
    mac: fields.MAC ?? mac ?? '',
    modelo: fields.MODELO ?? model ?? '',
    onu_numero: fields.ONU_NUMERO ?? '',
    raw: row,
  };
};

const inferManufacturerAliases = (...values) => {
  const name = values.filter(Boolean).join(' ').toLowerCase();
  if (name.includes('huawei') || name.includes('hwtc')) return ['HW'];
  if (name.includes('fiberhome') || name.includes('fhtt')) return ['FBT', 'FH', 'FB6001'];
  if (name.includes('zte') || name.includes('zteg')) return ['ZTE'];
  if (name.includes('nokia') || name.includes('alcl')) return ['NK'];
  if (name.includes('parks')) return ['PK'];
  if (name.includes('furukawa')) return ['FKG'];
  if (name.includes('intelbras')) return ['INTELBRASG16', 'INB'];
  if (name.includes('tp link') || name.includes('tplink') || name.includes('tplg')) return ['TPLINK'];
  return [];
};

const manufacturerKeywords = (aliases) => {
  const values = new Set();
  for (const alias of aliases) {
    if (alias === 'HW') ['HUAWEI', ' H.', 'H.'].forEach((value) => values.add(value));
    if (['FBT', 'FH', 'FB6001'].includes(alias)) {
      ['FIBERHOME', ' F.', 'F.', 'FBT', 'FB6001'].forEach((value) => values.add(value));
    }
    if (alias === 'ZTE') values.add('ZTE');
    if (['INTELBRASG16', 'INB'].includes(alias)) values.add('INTELBRAS');
  }
  return [...values];
};

const profileMatchesManufacturer = (profile, aliases) => {
  if (!aliases.length) return true;

  const fabricante = String(profile.fabricante_modelo || '').trim().toUpperCase();
  if (fabricante && aliases.includes(fabricante)) return true;
  if (fabricante) return false;

  const name = ` ${String(profile.nome || '').trim().toUpperCase()}`;
  return manufacturerKeywords(aliases).some((keyword) => name.includes(keyword));
};

const compactName = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const identifyPmsOlt = (olt, onu) => {
  const name = compactName([olt?.descricao, olt?.olt_nome, olt?.nome, onu?.olt_nome].filter(Boolean).join(' '));
  if (/OLT0?1PMS|OLTPMS0?1|PMSOLT0?1|PMS0?1OLT/.test(name)) return '01';
  if (/OLT0?2PMS|OLTPMS0?2|PMSOLT0?2|PMS0?2OLT/.test(name)) return '02';
  return null;
};

const identifyLocationProfile = (olt, onu) => {
  const name = compactName(
    [olt?.descricao, olt?.olt_nome, olt?.nome, onu?.olt_nome].filter(Boolean).join(' ')
  );
  const locations = [
    { code: 'PTC', aliases: ['PTC', 'PARACATU'] },
    { code: 'CRZ', aliases: ['CRZ', 'CRUZEIRODAFORTALEZA'] },
    { code: 'BRJ', aliases: ['BRJ', 'BREJOBONITO'] },
    { code: 'SGA', aliases: ['SGA', 'SAOGONCALODOABAETE'] },
  ];
  return locations.find((location) => location.aliases.some((alias) => name.includes(alias)))?.code;
};

const profilesForLocation = (rows, code) =>
  rows.filter((profile) => {
    const name = compactName(profile.nome);
    return (
      name.endsWith(`ONUBRIDGE${code}`) ||
      name.endsWith(`ONUINTEGRADA${code}`)
    );
  });

export const selectProfilesForOlt = (rows, olt, onu = null) => {
  const pmsOlt = identifyPmsOlt(olt, onu);
  if (pmsOlt) {
    return rows.filter((profile) => {
      const name = compactName(profile.nome);
      return (
        name.endsWith(`ONUBRIDGEOLT${pmsOlt}PMS`) ||
        name.endsWith(`ONUINTEGRADAOLT${pmsOlt}PMS`)
      );
    });
  }

  const locationProfile = identifyLocationProfile(olt, onu);
  if (locationProfile) {
    const matched = profilesForLocation(rows, locationProfile);
    if (matched.length) return matched;
  }

  const oltAliases = [
    String(olt?.fabricante_modelo || '').trim().toUpperCase(),
    ...inferManufacturerAliases(
      olt?.fabricante_modelo,
      olt?.olt_nome,
      olt?.descricao,
      olt?.nome
    ),
  ].filter(Boolean);
  const uniqueOltAliases = [...new Set(oltAliases)];

  if (uniqueOltAliases.includes('HW')) {
    return rows.filter((profile) => {
      const name = compactName(profile.nome);
      return (
        name.endsWith('ONUBRIDGEOLTHUAWEI') ||
        name.endsWith('ONUINTEGRADAOLTHUAWEI') ||
        name.includes('HBRIDGEAPENASOLTHUAWEI') ||
        name.includes('HINTEGRADAAPENASOLTHUAWEI')
      );
    });
  }

  const fallbackAliases = inferManufacturerAliases(onu?.modelo, onu?.mac);
  const uniqueAliases = uniqueOltAliases.length ? uniqueOltAliases : [...new Set(fallbackAliases)];

  const compatible = rows.filter((profile) => profileMatchesManufacturer(profile, uniqueAliases));
  return compatible.length ? compatible : rows;
};

const extractCreatedId = (response) => {
  const candidates = [
    response?.id,
    response?.registro,
    response?.last_insert_id,
    response?.data?.id,
    response?.retorno?.id,
  ];

  return candidates.find((value) => value !== undefined && value !== null && value !== '') ?? null;
};

const assertNotIxcError = (response, action) => {
  const message = typeof response === 'string' ? response : response?.message;
  const text = String(message || '');
  if (
    response?.type === 'error' ||
    /^\s*(erro|falha)\b/i.test(text) ||
    /panel-danger/i.test(text)
  ) {
    throw new Error(`IXC retornou erro ao ${action}: ${message || 'erro sem mensagem'}`);
  }
};

const isMissingOnuDeviceResponse = (response) => {
  const message = typeof response === 'string' ? response : response?.message;
  return /(registro|onu|dispositivo)\s+n[aã]o\s+(foi\s+)?encontrad[oa]|n[aã]o\s+existe|not\s+found/i.test(
    String(message || '')
  );
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const formatIxcDateTime = (date = new Date()) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(',', '');

const decodeHtmlText = (value) =>
  String(value || '')
    .replace(/<br\b[^>]*>|<\/(?:div|p|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();

const powerValue = (text, label) => {
  const match = text.match(new RegExp(`(?:^|\\n)${label}\\s*:\\s*([+-]?\\d+(?:[.,]\\d+)?)`, 'im'));
  return match ? match[1].replace(',', '.') : '';
};

export const parseOnuPowerSummary = (response) => {
  const text = decodeHtmlText(typeof response === 'string' ? response : response?.message || response);
  const summary = {
    // Neste relatorio Huawei do IXC, "Tx olt" representa o TX da ONU.
    onuTxDbm: powerValue(text, 'SEND POWER') || powerValue(text, 'Tx olt'),
    onuRxDbm: powerValue(text, 'RECV POWER') || powerValue(text, 'Sinal Rx'),
    oltRxDbm: powerValue(text, 'OLT RECV POWER') || powerValue(text, 'Rx olt') || powerValue(text, 'Sinal Tx'),
    status: text.match(/Status pot[eê]ncia\s*:\s*([^\n<]+)/i)?.[1]?.trim() || '',
  };

  if (!summary.onuRxDbm && !summary.onuTxDbm && !summary.oltRxDbm) {
    throw new Error('O IXC nao retornou os valores de potencia da ONU.');
  }
  return summary;
};

export const buildProvisionOsMessage = ({ box, port, serial, signal = {} }) =>
  [
    'Cabo: Nao informado',
    `Caixa: ${box || 'Nao informada'}`,
    `Porta: ${port || 'Nao informada'}`,
    `Sinal da ONU recebido na OLT (RX): ${signal.oltRxDbm ? `${signal.oltRxDbm} dBm` : 'Nao informado'}`,
    `Sinal Optico no Cliente: ${[
      signal.onuRxDbm ? `ONU RX ${signal.onuRxDbm} dBm` : '',
      signal.onuTxDbm ? `ONU TX ${signal.onuTxDbm} dBm` : '',
      signal.status ? `Status ${signal.status}` : '',
    ].filter(Boolean).join(' | ') || 'Nao informado'}`,
    `ONU: ${serial || 'Nao informada'}`,
    'Provisionado pelo bot Telegram.',
  ].join('\r\n');

export const buildRouterReplacementOsMessage = () =>
  [
    'Troca de roteador realizada.',
    'MAC do login PPPoE limpo no IXC.',
    'Atendimento executado pelo bot Telegram.',
  ].join('\r\n');

const positiveInteger = (value) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export const deriveProvisionNetworkFields = (rows, target) => {
  const samePon = rows.filter(
    (row) =>
      String(row.id_transmissor) === String(target.id_transmissor) &&
      String(row.slotno) === String(target.slotno) &&
      String(row.ponno) === String(target.ponno)
  );
  let reference = samePon.find((row) => positiveInteger(row.vlan));
  if (!reference && String(target.id_transmissor) === '1') {
    const slot = positiveInteger(target.slotno);
    const expectedVlan = slot && String(1000 + slot);
    const confirmedPons = new Set(
      rows
        .filter((row) =>
          String(row.id_transmissor) === '1' &&
          String(row.slotno) === String(target.slotno) &&
          String(row.vlan) === expectedVlan
        )
        .map((row) => String(row.ponno))
        .filter(Boolean)
    );
    if (confirmedPons.size >= 2) reference = { vlan: expectedVlan };
  }
  if (!reference) {
    throw new Error(
      `Nao encontrei uma VLAN comprovada para OLT ${target.id_transmissor}, slot ${target.slotno}, PON ${target.ponno}. Confira a interface da OLT e o acesso da API.`
    );
  }

  const usedOnuNumbers = new Set(
    samePon.map((row) => positiveInteger(row.onu_numero)).filter(Boolean)
  );
  const requestedOnuNumber = positiveInteger(target.onu_numero);
  const onuNumber =
    requestedOnuNumber && !usedOnuNumbers.has(requestedOnuNumber)
      ? requestedOnuNumber
      : Array.from({ length: 128 }, (_, index) => index + 1).find(
          (number) => !usedOnuNumbers.has(number)
        );

  if (!onuNumber) {
    throw new Error(`Nao ha numero de ONU livre no slot ${target.slotno}, PON ${target.ponno}.`);
  }

  return {
    vlan: String(reference.vlan),
    vlan_pppoe: String(reference.vlan_pppoe || ''),
    vlan_dhcp: String(reference.vlan_dhcp || ''),
    vlan_tr69: String(reference.vlan_tr69 || ''),
    vlan_iptv: String(reference.vlan_iptv || ''),
    vlan_voip: String(reference.vlan_voip || ''),
    vlan_outros: String(reference.vlan_outros || ''),
    onu_numero: String(onuNumber),
  };
};

const toNumber = (value) => {
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
};

const distanceMeters = (from, to) => {
  const earthRadiusMeters = 6371000;
  const lat1 = (from.latitude * Math.PI) / 180;
  const lat2 = (to.latitude * Math.PI) / 180;
  const deltaLat = ((to.latitude - from.latitude) * Math.PI) / 180;
  const deltaLon = ((to.longitude - from.longitude) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const IMPORT_PROJECT_ID = '1';
export const isImportProjectBox = (box) =>
  String(box?.id_projeto || '') === IMPORT_PROJECT_ID;

const isBoxAvailableForLocation = (box) => {
  const description = String(box?.descricao || box?.nome || '').trim();
  if (!isImportProjectBox(box) || box?.status !== 'A') return false;
  if (/^VRJ(?:\s*-|\s|$)/i.test(description)) {
    return true;
  }
  if (/^PTU(?:\s*-|\s|$)/i.test(description)) {
    return String(box?.id_transmissor) === '5';
  }
  if (/^PTC(?:\s*-|\s|$)/i.test(description)) {
    return String(box?.id_transmissor) === '1';
  }
  if (/^PARACATU(?:\s*-|\s|$)/i.test(description)) return false;
  return true;
};

export class IxcClient {
  constructor({ baseUrl, token, selfSigned = true, os = {} }) {
    this.os = {
      enabled: os.enabled !== false,
      subjectId: String(os.subjectId || '7'),
      sectorId: String(os.sectorId || '3'),
      processId: String(os.processId || '71'),
      taskId: String(os.taskId || '677'),
      responseId: String(os.responseId || '5'),
      diagnosisId: String(os.diagnosisId || '507'),
      technicianId: String(os.technicianId || ''),
    };
    this.httpsAgent = new https.Agent({ rejectUnauthorized: !selfSigned });
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 60000,
      headers: {
        Authorization: normalizeToken(token),
        'Content-Type': 'application/json',
      },
      httpsAgent: this.httpsAgent,
    });
    this.boxCache = {
      expiresAt: 0,
      rows: [],
    };
    this.cityCache = new Map();
  }

  async list(table, params = {}, { timeoutMs, retryTransient = true } = {}) {
    const shouldSkipParams =
      table === 'fh_onu_nao_autorizadas' && Object.keys(params).length === 0;

    const request = () => this.http.get(`/${table}`, {
      headers: { ixcsoft: 'listar' },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      data: shouldSkipParams
        ? undefined
        : {
            page: '1',
            rp: '20',
            sortname: `${table}.id`,
            sortorder: 'desc',
            ...params,
          },
    });

    let response;
    try {
      response = await request();
    } catch (error) {
      const transientCodes = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'];
      if (!retryTransient || !transientCodes.includes(error?.code)) throw error;
      console.warn(`IXC oscilou ao consultar ${table}; repetindo a leitura uma vez.`);
      response = await request();
    }
    return dataRows(response);
  }

  async read(table, id) {
    const rows = await this.list(table, {
      qtype: `${table}.id`,
      query: String(id),
      oper: '=',
      rp: '1',
    });
    return rows[0] ?? null;
  }

  async create(table, body) {
    const response = await this.http.post(`/${table}`, body, {
      headers: { ixcsoft: 'inserir' },
    });
    return response.data;
  }

  async update(table, id, body) {
    const response = await this.http.put(`/${table}/${id}`, body, {
      headers: { ixcsoft: 'alterar' },
    });
    return response.data;
  }

  async actionGet(resource, data = {}) {
    const response = await this.http.get(`/${resource}`, {
      headers: { ixcsoft: 'listar' },
      data,
    });
    return response.data;
  }

  async actionPost(resource, data = {}) {
    const response = await this.http.post(`/${resource}`, data);
    return response.data;
  }

  async delete(table, id) {
    const response = await this.http.delete(`/${table}/${id}`, {
      headers: { ixcsoft: 'deletar' },
    });
    return response.data;
  }

  async findPendingOnusBySerialSuffix(serialSuffix) {
    const suffix = String(serialSuffix).trim();
    const rows = await this.listPendingOnus({ refresh: true });
    return this.filterPendingOnusBySerialSuffix(rows, suffix);
  }

  async listPendingOnus() {
    try {
      // Sem filtros, o endpoint executa a mesma acao do botao "Consultar todas"
      // do IXC e devolve a fila atualizada de todas as OLTs.
      return await this.list(
        'fh_onu_nao_autorizadas',
        {},
        { timeoutMs: 60000, retryTransient: false }
      );
    } catch (error) {
      if (['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
        const timeoutError = new Error(
          'O IXC demorou para concluir o Consultar todas. Aguarde um pouco e tente novamente.'
        );
        timeoutError.code = 'IXC_OLT_LOOKUP_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    }
  }

  filterPendingOnusBySerialSuffix(rows, suffix) {
    return rows
      .map(normalizePendingOnu)
      .filter((onu) => {
        const haystack = [onu.mac, onu.Chassi]
          .filter(Boolean)
          .join(' ')
          .toUpperCase();
        return haystack.includes(suffix.toUpperCase());
      });
  }

  async findAuthorizedOnusBySerialSuffix(serialSuffix) {
    const suffix = String(serialSuffix).trim();
    const suffixUpper = suffix.toUpperCase();
    const partialRows = await this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.mac',
      query: suffix,
      oper: 'L',
      rp: '200',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });
    const partialMatches = partialRows.filter((onu) =>
      String(onu.mac || '').toUpperCase().includes(suffixUpper)
    );

    if (partialMatches.length) return partialMatches;

    const foundRows = [];
    const pageSize = 500;
    for (let page = 1; page <= 30; page += 1) {
      const rows = await this.list('radpop_radio_cliente_fibra', {
        page: String(page),
        rp: String(pageSize),
        sortname: 'radpop_radio_cliente_fibra.id',
        sortorder: 'desc',
      });

      const matches = rows.filter((onu) => {
        return String(onu.mac || '').toUpperCase().includes(suffixUpper);
      });

      foundRows.push(...matches);
      if (rows.length < pageSize) break;
    }

    return [...new Map(foundRows.map((row) => [String(row.id), row])).values()];
  }

  async removeAuthorizedOnu(onuId) {
    const deviceResponse = await this.actionPost('botao_excluir_dispositivo_22434', {
      id: String(onuId),
    });
    assertNotIxcError(deviceResponse, 'desautorizar ONU no dispositivo');

    const deleteResponse = await this.delete('radpop_radio_cliente_fibra', onuId);
    assertNotIxcError(deleteResponse, 'remover cadastro antigo da ONU');
    return { deviceResponse, deleteResponse };
  }

  async removeDuplicateFiberClient(onuId) {
    let deviceResponse;
    try {
      deviceResponse = await this.actionPost('botao_excluir_dispositivo_22434', {
        id: String(onuId),
      });
      assertNotIxcError(deviceResponse, 'desautorizar cadastro duplicado da ONU');
    } catch (error) {
      if (!isMissingOnuDeviceResponse(deviceResponse)) throw error;
      console.warn(`ONU do cadastro antigo ${onuId} ja nao existe na OLT; removendo cadastro orfao.`);
    }

    const deleteResponse = await this.delete('radpop_radio_cliente_fibra', onuId);
    assertNotIxcError(deleteResponse, 'excluir cadastro duplicado da ONU');
    return { deviceResponse, deleteResponse };
  }

  async findFiberClientsByContract(contractId) {
    return this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_contrato',
      query: String(contractId),
      oper: '=',
      rp: '20',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });
  }

  async findFiberClientsByLogin(loginId) {
    return this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_login',
      query: String(loginId),
      oper: '=',
      rp: '20',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });
  }

  async activateContract(contractId) {
    return this.actionGet('cliente_contrato_ativar_cliente', {
      qtype: 'cliente_contrato_ativar_cliente.id',
      id_contrato: String(contractId),
    });
  }

  async clearLoginMac(loginId) {
    return this.actionPost('radusuarios_25452', {
      get_id: String(loginId),
    });
  }

  async transferFiberClient(fiberId, patch) {
    const current = await this.read('radpop_radio_cliente_fibra', fiberId);
    if (!current) {
      throw new Error(`Cadastro de fibra ${fiberId} nao encontrado para transferir titularidade.`);
    }

    const response = await this.update('radpop_radio_cliente_fibra', fiberId, {
      ...current,
      ...patch,
    });
    assertNotIxcError(response, 'transferir titularidade do cadastro de fibra');
    return response;
  }

  async findBoxes(query, oltId) {
    const trimmed = String(query).trim();
    const numeric = /^\d+$/.test(trimmed);
    const rows = await this.list('rad_caixa_ftth', {
      qtype: numeric ? 'rad_caixa_ftth.id' : 'rad_caixa_ftth.descricao',
      query: trimmed,
      oper: numeric ? '=' : 'LIKE',
      rp: '20',
      sortname: 'rad_caixa_ftth.descricao',
      sortorder: 'asc',
    });

    return rows.filter(
      (box) =>
        isImportProjectBox(box) &&
        box.status === 'A' &&
        (!oltId || !box.id_transmissor || String(box.id_transmissor) === String(oltId))
    );
  }

  async findBoxesNearLocation(location, { radiusMeters = 300, limit = 10 } = {}) {
    const origin = {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
    };

    const rows = await this.listAllBoxes();

    return rows
      .map((box) => {
        const latitude = toNumber(box.latitude);
        const longitude = toNumber(box.longitude);
        if (latitude === null || longitude === null) return null;

        return {
          ...box,
          distanceMeters: Math.round(distanceMeters(origin, { latitude, longitude })),
        };
      })
      .filter((box) => box && isBoxAvailableForLocation(box) && box.distanceMeters <= radiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, limit);
  }

  async findFreeBoxPorts(box) {
    const capacity = Number.parseInt(box?.capacidade, 10);
    if (!Number.isFinite(capacity) || capacity <= 0) return [];

    const rows = await this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_caixa_ftth',
      query: String(box.id),
      oper: '=',
      rp: '500',
      sortname: 'radpop_radio_cliente_fibra.porta_ftth',
      sortorder: 'asc',
    });

    const usedPorts = new Set(
      rows
        .map((row) => Number.parseInt(row.porta_ftth, 10))
        .filter((port) => Number.isFinite(port) && port > 0)
    );

    return Array.from({ length: capacity }, (_, index) => index + 1).filter(
      (port) => !usedPorts.has(port)
    );
  }

  async listAllBoxes() {
    const now = Date.now();
    if (this.boxCache.expiresAt > now) return this.boxCache.rows;

    const rows = await this.list('rad_caixa_ftth', {
      page: '1',
      rp: '20000',
      sortname: 'rad_caixa_ftth.id',
      sortorder: 'desc',
    });

    this.boxCache = {
      expiresAt: now + 2 * 60 * 1000,
      rows,
    };
    return rows;
  }

  async findClient(clientId) {
    return this.read('cliente', clientId);
  }

  async findCityName(cityId) {
    if (!cityId || cityId === '0') return '';
    const key = String(cityId);
    if (this.cityCache.has(key)) return this.cityCache.get(key);

    const rows = await this.list('cidade', {
      qtype: 'cidade.id',
      query: key,
      oper: '=',
      rp: '1',
      sortname: 'cidade.id',
      sortorder: 'desc',
    });

    const name = rows[0]?.nome || '';
    this.cityCache.set(key, name);
    return name;
  }

  async findContractsByClient(clientId) {
    return this.list('cliente_contrato', {
      qtype: 'cliente_contrato.id_cliente',
      query: String(clientId),
      oper: '=',
      rp: '100',
      sortname: 'cliente_contrato.id',
      sortorder: 'desc',
    });
  }

  async findPppoeLoginsByContract(contractId) {
    return this.list('radusuarios', {
      qtype: 'radusuarios.id_contrato',
      query: String(contractId),
      oper: '=',
      rp: '20',
      sortname: 'radusuarios.id',
      sortorder: 'desc',
    });
  }

  async findPppoeLoginsByClient(clientId) {
    return this.list('radusuarios', {
      qtype: 'radusuarios.id_cliente',
      query: String(clientId),
      oper: '=',
      rp: '100',
      sortname: 'radusuarios.id',
      sortorder: 'desc',
    });
  }

  async findFiberClientsByClient(clientId) {
    const [logins, contracts] = await Promise.all([
      this.findPppoeLoginsByClient(clientId),
      this.findContractsByClient(clientId),
    ]);
    const groups = await Promise.all([
      ...logins.map((login) => this.findFiberClientsByLogin(login.id)),
      ...contracts.map((contract) => this.findFiberClientsByContract(contract.id)),
    ]);
    return [...new Map(groups.flat().map((fiber) => [String(fiber.id), fiber])).values()];
  }

  async findFiberClientsForContract(contractId) {
    const [directFibers, logins] = await Promise.all([
      this.findFiberClientsByContract(contractId),
      this.findPppoeLoginsByContract(contractId),
    ]);
    const loginFibers = await Promise.all(
      logins.map((login) => this.findFiberClientsByLogin(login.id))
    );
    return [
      ...new Map(
        [...directFibers, ...loginFibers.flat()].map((fiber) => [String(fiber.id), fiber])
      ).values(),
    ];
  }

  async findFiberClientsByBox(boxId) {
    const rows = await this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_caixa_ftth',
      query: String(boxId),
      oper: '=',
      rp: '500',
      sortname: 'radpop_radio_cliente_fibra.porta_ftth',
      sortorder: 'asc',
    });
    return rows.sort((a, b) =>
      Number.parseInt(a.porta_ftth || '0', 10) - Number.parseInt(b.porta_ftth || '0', 10)
    );
  }

  async enrichFiberBoxNames(fibers) {
    const rows = Array.isArray(fibers) ? fibers : [];
    const boxIds = [...new Set(
      rows
        .map((fiber) => fiber.id_caixa_ftth)
        .filter((id) => id && String(id) !== '0')
        .map(String)
    )];
    const boxResults = await Promise.allSettled(
      boxIds.map((id) => this.read('rad_caixa_ftth', id))
    );
    const boxNames = new Map();
    boxResults.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const name = result.value.descricao || result.value.nome;
      if (name) boxNames.set(boxIds[index], name);
    });

    return rows.map((fiber) => ({
      ...fiber,
      caixa_nome: fiber.caixa_nome || boxNames.get(String(fiber.id_caixa_ftth)) || '',
    }));
  }

  async enrichFiberClientNames(fibers) {
    const rows = Array.isArray(fibers) ? fibers : [];
    const loginIds = [...new Set(
      rows.map((fiber) => fiber.id_login).filter((id) => id && String(id) !== '0').map(String)
    )];
    const loginResults = await Promise.allSettled(
      loginIds.map((id) => this.read('radusuarios', id))
    );
    const logins = new Map();
    loginResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        logins.set(loginIds[index], result.value);
      }
    });

    const clientIds = [...new Set(
      [...logins.values()]
        .map((login) => login.id_cliente)
        .filter((id) => id && String(id) !== '0')
        .map(String)
    )];
    const clientResults = await Promise.allSettled(
      clientIds.map((id) => this.findClient(id))
    );
    const clients = new Map();
    clientResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        clients.set(clientIds[index], result.value);
      }
    });

    return rows.map((fiber) => {
      const login = logins.get(String(fiber.id_login));
      const client = login ? clients.get(String(login.id_cliente)) : null;
      return {
        ...fiber,
        nome: client?.razao || login?.login || fiber.nome,
      };
    });
  }

  async findProfilesByOlt(olt, onu = null) {
    const rows = await this.list('radpop_radio_cliente_fibra_perfil', {
      rp: '500',
      sortname: 'radpop_radio_cliente_fibra_perfil.nome',
      sortorder: 'asc',
    });

    return selectProfilesForOlt(rows, olt, onu);
  }

  async findProvisionedOnu({ createResponse, mac, loginId, contractId }) {
    const createdId = extractCreatedId(createResponse);
    if (createdId) {
      const byId = await this.read('radpop_radio_cliente_fibra', createdId);
      if (byId) return byId;
    }

    const rows = await this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.mac',
      query: String(mac),
      oper: '=',
      rp: '10',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });

    return (
      rows.find(
        (row) =>
          (!loginId || String(row.id_login) === String(loginId)) &&
          (!contractId || String(row.id_contrato) === String(contractId))
      ) ??
      rows[0] ??
      null
    );
  }

  async prepareProvisionPayload(payload) {
    const target = payload.clienteFibra;
    const rows = await this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_transmissor',
      query: String(target.id_transmissor),
      oper: '=',
      rp: '5000',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });
    const networkFields = deriveProvisionNetworkFields(rows, target);
    return {
      ...payload,
      clienteFibra: { ...target, ...networkFields },
    };
  }

  async findFiberClientsByMac(mac) {
    return this.list('radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.mac',
      query: String(mac),
      oper: '=',
      rp: '20',
      sortname: 'radpop_radio_cliente_fibra.id',
      sortorder: 'desc',
    });
  }

  async ensureOnuAuthorizationApiAvailable() {
    const response = await this.actionPost('botao_gravar_dispositivo_22408', { id: '0' });
    const message = typeof response === 'string' ? response : response?.message;
    if (/n[aã]o est[aá] dispon[ií]vel/i.test(String(message || ''))) {
      throw new Error(
        'A API do IXC ainda nao liberou o recurso botao_gravar_dispositivo_22408.'
      );
    }
  }

  async authorizeOnu(fiberId) {
    const response = await this.actionPost('botao_gravar_dispositivo_22408', {
      id: String(fiberId),
    });
    assertNotIxcError(response, 'gravar ONU no dispositivo pela API');
    return response;
  }

  async authorizePendingOnu(pendingOnuId) {
    if (!pendingOnuId) throw new Error('O IXC nao retornou o ID original da ONU pendente.');
    const response = await this.actionPost('fh_onu_nao_autorizadas_22396', {
      get_id: String(pendingOnuId),
    });
    assertNotIxcError(response, 'autorizar ONU pela API');
    return response;
  }

  async getOnuPowerSummary(fiberId, { attempts = 3, delayMs = 4000 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.actionPost('botao_rel_22991', {
          id: String(fiberId),
        });
        assertNotIxcError(response, 'consultar Potencia/Resumo ONU');
        return parseOnuPowerSummary(response);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await wait(delayMs);
      }
    }
    throw lastError;
  }

  async getFiberPowerReports(fibers, { concurrency = 4 } = {}) {
    const rows = Array.isArray(fibers) ? fibers : [];
    const reports = new Array(rows.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const fiber = rows[index];
        try {
          reports[index] = {
            fiber,
            signal: await this.getOnuPowerSummary(fiber.id, { attempts: 1 }),
            status: 'Online',
          };
        } catch (error) {
          const message = String(error?.message || '');
          reports[index] = {
            fiber,
            signal: null,
            status: /ONU Offline|unactive|offline/i.test(message) ? 'Offline' : 'Sem leitura',
          };
        }
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), rows.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return reports;
  }

  async findCreatedTicket({ createResponse, contractId, message }) {
    const createdId = extractCreatedId(createResponse);
    if (createdId) {
      const ticket = await this.read('su_ticket', createdId);
      if (ticket) return ticket;
    }

    const rows = await this.list('su_ticket', {
      qtype: 'su_ticket.id_contrato',
      query: String(contractId),
      oper: '=',
      rp: '20',
      sortname: 'su_ticket.id',
      sortorder: 'desc',
    });
    return (
      rows.find(
        (ticket) =>
          String(ticket.id_assunto) === this.os.subjectId &&
          String(ticket.menssagem || '').trim() === String(message).trim()
      ) || null
    );
  }

  async waitForTicketOs(ticketId) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const rows = await this.list('su_oss_chamado', {
        qtype: 'su_oss_chamado.id_ticket',
        query: String(ticketId),
        oper: '=',
        rp: '10',
        sortname: 'su_oss_chamado.id',
        sortorder: 'desc',
      });
      if (rows[0]) return rows[0];
      await wait(1000);
    }
    throw new Error(`Atendimento ${ticketId} criado, mas o IXC nao gerou a OS.`);
  }

  async createAndCloseServiceOs({
    client,
    contract,
    login,
    address,
    message,
    title,
  }) {
    if (!this.os.enabled) return null;
    const technicianId = this.os.technicianId;
    const ticketPayload = {
      tipo: 'C',
      id_cliente: String(client.id),
      id_assunto: this.os.subjectId,
      titulo: String(title),
      status: 'P',
      su_status: 'N',
      prioridade: 'M',
      id_ticket_setor: this.os.sectorId,
      id_ticket_origem: 'I',
      id_wfl_processo: this.os.processId,
      id_su_diagnostico: '0',
      origem_endereco: 'L',
      menssagem: message,
      endereco: String(address || ''),
      id_filial: String(contract.id_filial || client.id_filial || '1'),
      id_login: String(login.id),
      id_contrato: String(contract.id),
      origem_cadastro: 'P',
      ...(technicianId
        ? { id_usuarios: technicianId, id_responsavel_tecnico: technicianId }
        : {}),
    };

    const createResponse = await this.create('su_ticket', ticketPayload);
    assertNotIxcError(createResponse, 'abrir atendimento de provisionamento');
    const ticket = await this.findCreatedTicket({
      createResponse,
      contractId: contract.id,
      message,
    });
    if (!ticket?.id) throw new Error('Atendimento criado, mas o IXC nao retornou seu ID.');

    const serviceOrder = await this.waitForTicketOs(ticket.id);
    const closedAt = formatIxcDateTime();
    const responsibleId = technicianId || serviceOrder.id_tecnico || ticket.id_responsavel_tecnico;
    if (!responsibleId || String(responsibleId) === '0') {
      throw new Error(
        `OS ${serviceOrder.id} criada, mas falta configurar IXC_OS_TECHNICIAN_ID para finaliza-la.`
      );
    }

    const closeResponse = await this.create('su_oss_chamado_fechar', {
      id_chamado: String(serviceOrder.id),
      id_tarefa_atual: String(serviceOrder.id_wfl_tarefa || this.os.taskId),
      eh_tarefa_decisao: 'S',
      sequencia_atual: '1',
      proxima_sequencia_forcada: '2',
      finaliza_processo_aux: 'S',
      gera_comissao_aux: 'ROS',
      id_processo: String(ticket.id_wfl_processo || this.os.processId),
      data_inicio: closedAt,
      data_final: closedAt,
      id_resposta: this.os.responseId,
      mensagem: message,
      id_tecnico: String(responsibleId),
      id_equipe: '',
      gera_comissao: 'S',
      status: 'F',
      data: '',
      id_evento: '',
      id_su_diagnostico: this.os.diagnosisId,
      id_diagnostico_especifico: '',
      justificativa_sla_atrasado: '',
      id_evento_status: '',
      finaliza_processo: 'S',
      id_proxima_tarefa: '',
      id_proxima_tarefa_aux: '',
      latitude: '',
      longitude: '',
      gps_time: '',
      historico: '',
    });
    assertNotIxcError(closeResponse, `finalizar OS ${serviceOrder.id}`);

    return { ticket, serviceOrder, closeResponse };
  }

  async createAndCloseProvisioningOs({
    client,
    contract,
    login,
    fiberId,
    box,
    port,
    serial,
    address,
    signal: suppliedSignal,
  }) {
    if (!this.os.enabled) return null;

    const shouldReadSignal = suppliedSignal === undefined;
    if (shouldReadSignal && !fiberId) {
      throw new Error('Cadastro de fibra sem ID para consultar a potencia da ONU.');
    }
    const signal = shouldReadSignal
      ? await this.getOnuPowerSummary(fiberId)
      : suppliedSignal || {};
    const message = buildProvisionOsMessage({ box, port, serial, signal });
    const result = await this.createAndCloseServiceOs({
      client,
      contract,
      login,
      address,
      message,
      title: 'Provisionamento',
    });
    return result ? { ...result, signal } : null;
  }

  async createAndCloseRouterReplacementOs({ client, contract, login, address }) {
    return this.createAndCloseServiceOs({
      client,
      contract,
      login,
      address,
      message: buildRouterReplacementOsMessage(),
      title: 'Troca de roteador',
    });
  }

  async provisionOnu(payload) {
    const prepared = await this.prepareProvisionPayload(payload);
    await this.ensureOnuAuthorizationApiAvailable();
    const [macDuplicates, loginDuplicates] = await Promise.all([
      this.findFiberClientsByMac(prepared.clienteFibra.mac),
      this.findFiberClientsByLogin(prepared.clienteFibra.id_login),
    ]);
    const duplicates = [
      ...new Map(
        [...macDuplicates, ...loginDuplicates].map((duplicate) => [String(duplicate.id), duplicate])
      ).values(),
    ];
    for (const duplicate of duplicates) {
      console.log(
        `Removendo cadastro de fibra antigo ${duplicate.id} antes do novo provisionamento.`
      );
      await this.removeDuplicateFiberClient(duplicate.id);
    }
    if (duplicates.length) {
      const [remainingByMac, remainingByLogin] = await Promise.all([
        this.findFiberClientsByMac(prepared.clienteFibra.mac),
        this.findFiberClientsByLogin(prepared.clienteFibra.id_login),
      ]);
      const remainingDuplicates = [...remainingByMac, ...remainingByLogin];
      if (remainingDuplicates.length) {
        throw new Error('O cadastro antigo da ONU permaneceu no IXC apos a tentativa de limpeza.');
      }
    }
    const createResponse = await this.create('radpop_radio_cliente_fibra', prepared.clienteFibra);
    assertNotIxcError(createResponse, 'provisionar ONU');

    const provisionedOnu = await this.findProvisionedOnu({
      createResponse,
      mac: prepared.clienteFibra.mac,
      loginId: prepared.clienteFibra.id_login,
      contractId: prepared.clienteFibra.id_contrato,
    });
    if (!provisionedOnu?.id) throw new Error('Cadastro salvo, mas o IXC nao retornou o ID da ONU.');

    await this.authorizePendingOnu(prepared.pendingOnuId);
    await this.authorizeOnu(provisionedOnu.id);
    const confirmed = await this.read('radpop_radio_cliente_fibra', provisionedOnu.id);

    return {
      createResponse,
      provisionedOnu: confirmed || provisionedOnu,
      authorized: true,
    };
  }
}
