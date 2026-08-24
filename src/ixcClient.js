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
  constructor({ baseUrl, token, selfSigned = true }) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 60000,
      headers: {
        Authorization: normalizeToken(token),
        'Content-Type': 'application/json',
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: !selfSigned,
      }),
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

  async provisionOnu(payload) {
    const createResponse = await this.create('radpop_radio_cliente_fibra', payload.clienteFibra);
    assertNotIxcError(createResponse, 'provisionar ONU');

    let deleteResponse = null;
    if (payload.pendingOnuId) {
      deleteResponse = await this.delete('fh_onu_nao_autorizadas', payload.pendingOnuId);
    }

    const provisionedOnu = await this.findProvisionedOnu({
      createResponse,
      mac: payload.clienteFibra.mac,
      loginId: payload.clienteFibra.id_login,
      contractId: payload.clienteFibra.id_contrato,
    });

    return {
      createResponse,
      deleteResponse,
      provisionedOnu,
    };
  }
}
