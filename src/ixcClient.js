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
  if (response?.type === 'error') {
    throw new Error(`IXC retornou erro ao ${action}: ${response.message || 'erro sem mensagem'}`);
  }
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

export const buildProvisionOsMessage = ({ box, port, serial }) =>
  [
    'Cabo: Nao informado',
    `Caixa: ${box || 'Nao informada'}`,
    `Porta: ${port || 'Nao informada'}`,
    'Sinal Optico na Caixa: Nao informado',
    'Sinal Optico no Cliente: Nao informado',
    `ONU: ${serial || 'Nao informada'}`,
    'Provisionado pelo bot Telegram.',
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
  const reference = samePon.find((row) => positiveInteger(row.vlan));
  if (!reference) {
    throw new Error(
      `Nao encontrei uma VLAN valida para OLT ${target.id_transmissor}, slot ${target.slotno}, PON ${target.ponno}. Libere a consulta da interface da OLT no usuario da API.`
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

export class IxcClient {
  constructor({ baseUrl, token, selfSigned = true, webEmail = '', webPassword = '', os = {} }) {
    this.origin = new URL(baseUrl).origin;
    this.webEmail = webEmail;
    this.webPassword = webPassword;
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

  async list(table, params = {}) {
    const shouldSkipParams =
      table === 'fh_onu_nao_autorizadas' && Object.keys(params).length === 0;

    const response = await this.http.get(`/${table}`, {
      headers: { ixcsoft: 'listar' },
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
    let rows = await this.listPendingOnus({ refresh: true });
    let matches = this.filterPendingOnusBySerialSuffix(rows, suffix);

    if (!matches.length) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      rows = await this.listPendingOnus({ refresh: false });
      matches = this.filterPendingOnusBySerialSuffix(rows, suffix);
    }

    return matches;
  }

  async listPendingOnus({ refresh = true } = {}) {
    const response = await this.http.get('/fh_onu_nao_autorizadas', {
      headers: { ixcsoft: 'listar' },
      data: refresh ? { consultar_onu: 'S' } : undefined,
    });
    return dataRows(response);
  }

  filterPendingOnusBySerialSuffix(rows, suffix) {
    return rows
      .map(normalizePendingOnu)
      .filter((onu) => {
        const haystack = [onu.mac, onu.Chassi, onu.ponid, onu.modelo]
          .filter(Boolean)
          .join(' ')
          .toUpperCase();
        return haystack.includes(suffix.toUpperCase());
      });
  }

  async findAuthorizedOnusBySerialSuffix(serialSuffix) {
    const suffix = String(serialSuffix).trim();
    const suffixUpper = suffix.toUpperCase();
    const huaweiHexCandidates =
      suffixUpper.length === 7
        ? '0123456789ABCDEF'.split('').map((nibble) => `48575443${nibble}${suffixUpper}`)
        : [];
    const exactCandidates = [
      suffix,
      suffixUpper,
      suffix.toLowerCase(),
      ...huaweiHexCandidates,
    ];
    const exactResults = await Promise.all(
      [...new Set(exactCandidates)].map((candidate) =>
        this.list('radpop_radio_cliente_fibra', {
          qtype: 'radpop_radio_cliente_fibra.mac',
          query: candidate,
          oper: '=',
          rp: '20',
          sortname: 'radpop_radio_cliente_fibra.id',
          sortorder: 'desc',
        })
      )
    );
    const queriedRows = exactResults.flat();

    const exactRows = [...new Map(queriedRows.map((row) => [String(row.id), row])).values()].filter((onu) => {
      const haystack = [onu.mac, onu.nome, onu.ponid, onu.onu_tipo]
        .filter(Boolean)
        .join(' ')
        .toUpperCase();
      return haystack.includes(suffix.toUpperCase());
    });

    if (exactRows.length) return exactRows;

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
        const haystack = [onu.mac, onu.nome, onu.ponid, onu.onu_tipo]
          .filter(Boolean)
          .join(' ')
          .toUpperCase();
        return haystack.includes(suffixUpper);
      });

      foundRows.push(...matches);
      if (foundRows.length || rows.length < pageSize) break;
    }

    return [...new Map(foundRows.map((row) => [String(row.id), row])).values()];
  }

  async removeAuthorizedOnu(onuId) {
    const response = await this.delete('radpop_radio_cliente_fibra', onuId);
    assertNotIxcError(response, 'remover cadastro antigo da ONU');
    return response;
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
    const response = await this.update('radpop_radio_cliente_fibra', fiberId, patch);
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

    if (!oltId) return rows;
    return rows.filter((box) => !box.id_transmissor || String(box.id_transmissor) === String(oltId));
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
      .filter((box) => box && box.status === 'A' && box.distanceMeters <= radiusMeters)
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
      rp: '20',
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

  async createWebSession() {
    if (!this.webEmail || !this.webPassword) {
      throw new Error(
        'Autorizacao na OLT nao configurada. Informe IXC_WEB_EMAIL e IXC_WEB_PASSWORD de uma conta IXC dedicada, sem 2FA.'
      );
    }

    const cookies = new Map();
    const captureCookies = (response) => {
      for (const header of response.headers['set-cookie'] || []) {
        const [pair] = header.split(';');
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    };
    const request = async (url, options = {}) => {
      const response = await axios({
        url: `${this.origin}${url}`,
        method: options.method || 'GET',
        data: options.data,
        headers: {
          ...(cookies.size
            ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
            : {}),
          ...options.headers,
        },
        httpsAgent: this.httpsAgent,
        timeout: 60000,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      captureCookies(response);
      return response;
    };

    await request('/adm.php');
    const emailForm = new FormData();
    emailForm.append('email', this.webEmail);
    const loginPath = '/api-module/auth/login';
    const emailResponse = await request(loginPath, { method: 'POST', data: emailForm });
    const emailResult = emailResponse.data?.data || emailResponse.data;
    if (!['password', 'token'].includes(emailResult?.type)) {
      throw new Error(
        emailResponse.data?.messages?.[0]?.body ||
          emailResponse.data?.message?.body ||
          'Conta web do IXC nao reconhecida.'
      );
    }

    const sendPassword = () => {
      const passwordForm = new FormData();
      passwordForm.append('password', this.webPassword);
      return request(loginPath, { method: 'POST', data: passwordForm });
    };
    let passwordResponse = await sendPassword();
    if (
      passwordResponse.data?.status === '0' &&
      /sessao ativa|sessão ativa/i.test(passwordResponse.data?.messages?.[0]?.body || '')
    ) {
      passwordResponse = await sendPassword();
    }
    const passwordResult = passwordResponse.data?.data || passwordResponse.data;
    if (passwordResult?.type === 'token') {
      throw new Error('A conta web do IXC exige 2FA. Use uma conta dedicada sem 2FA para o bot.');
    }
    if (
      passwordResponse.status !== 302 &&
      passwordResult?.type !== 'redirect' &&
      passwordResult?.message?.type !== 'success'
    ) {
      throw new Error(
        passwordResponse.data?.messages?.[0]?.body ||
          passwordResult?.message?.body ||
          'Falha no login web do IXC.'
      );
    }
    return request;
  }

  async authorizeOnu(fiberId) {
    const request = await this.createWebSession();
    const path = `/aplicativo/radpop_radio_cliente_fibra/rel_22408.php?id=${encodeURIComponent(fiberId)}`;
    const verify = await request(`${path}&verify=s`);
    if (verify.data?.STATUS !== true) {
      throw new Error('A OLT informou que esta ONU ja esta autorizada com outros dados.');
    }

    const response = await request(path);
    const report = String(response.data || '');
    if (/sess[aã]o foi finalizada|\b(erro|error|falha)\b/i.test(report)) {
      throw new Error(`IXC nao confirmou a autorizacao na OLT: ${report.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    }
    return response.data;
  }

  async authorizePendingOnu(pendingOnuId) {
    if (!pendingOnuId) throw new Error('O IXC nao retornou o ID original da ONU pendente.');
    const response = await this.actionPost('fh_onu_nao_autorizadas_22396', {
      get_id: String(pendingOnuId),
    });
    assertNotIxcError(response, 'autorizar ONU pela API');
    return response;
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

  async createAndCloseProvisioningOs({ client, contract, login, box, port, serial, address }) {
    if (!this.os.enabled) return null;

    const message = buildProvisionOsMessage({ box, port, serial });
    const technicianId = this.os.technicianId;
    const ticketPayload = {
      tipo: 'C',
      id_cliente: String(client.id),
      id_assunto: this.os.subjectId,
      titulo: 'Provisionamento',
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

  async provisionOnu(payload) {
    const prepared = await this.prepareProvisionPayload(payload);
    const duplicates = await this.findFiberClientsByMac(prepared.clienteFibra.mac);
    if (duplicates.length) {
      throw new Error(
        `Ja existe cadastro de fibra para esta ONU (ID ${duplicates[0].id}, contrato ${duplicates[0].id_contrato || '-'}). Remova ou transfira o cadastro antigo antes de instalar.`
      );
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
