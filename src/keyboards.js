import { Markup } from 'telegraf';

export const provisionKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Provisionar', 'provision:start')],
    [Markup.button.callback('Verificar sinal', 'signal:start')],
  ]);

export const signalKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Sinal do cliente', 'signal:client')],
    [Markup.button.callback('Sinal dos clientes de uma caixa', 'signal:box')],
    [Markup.button.callback('Voltar', 'signal:back')],
  ]);

export const signalResultKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Verificar outro sinal', 'signal:again')],
    [Markup.button.callback('Menu', 'signal:menu')],
  ]);

export const provisionedSignalKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Conferir sinal', 'provisioned:signal')],
  ]);

export const credentialsCopyKeyboard = (login, password) =>
  Markup.inlineKeyboard([
    [
      {
        text: 'Copiar PPPoE',
        style: 'primary',
        copy_text: { text: String(login || '') },
      },
    ],
    [
      {
        text: 'Copiar senha',
        style: 'primary',
        copy_text: { text: String(password || '') },
      },
    ],
  ]);

export const serviceKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Instalacao', 'service:instalacao')],
    [Markup.button.callback('Mudanca de endereco', 'service:mudanca')],
    [Markup.button.callback('Troca de equipamento', 'service:troca')],
    [Markup.button.callback('Troca de titularidade', 'service:titularidade')],
  ]);

export const swapEquipmentKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Trocar ONU', 'swapequipment:onu')],
    [Markup.button.callback('Trocar roteador', 'swapequipment:router')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const routerReplacementKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Confirmar troca do roteador', 'routerreplace:confirm')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const titularityKeyboard = (hasConflict = false) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        hasConflict ? 'Remover ONU existente e transferir' : 'Transferir para novo titular',
        'titularity:transfer'
      ),
    ],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const rowsKeyboard = (prefix, rows, labelFn, menuToken) => {
  const buttons = rows.slice(0, 30).map((row, index) => [
    Markup.button.callback(
      labelFn(row, index).slice(0, 60),
      `${prefix}:${menuToken}:${index}`
    ),
  ]);
  return Markup.inlineKeyboard(buttons);
};

export const confirmKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Confirmar provisionamento', 'confirm:yes')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const retryProvisionKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Tentar novamente', 'confirm:retry')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const retryPppoeKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Verificar PPPoE novamente', 'pppoe:retry')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const onuConfirmationKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Sim, e esta ONU', 'addressonu:yes')],
    [Markup.button.callback('Nao, buscar novamente', 'addressonu:no')],
  ]);

export const oldFiberKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Desautorizar e remover cadastro antigo', 'oldfiber:delete')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const swapOldFiberKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Remover equipamento antigo e continuar', 'swapoldfiber:delete')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const portsKeyboard = (ports, menuToken) => {
  const buttons = [];
  for (let index = 0; index < ports.length; index += 4) {
    buttons.push(
      ports
        .slice(index, index + 4)
        .map((port) => Markup.button.callback(String(port), `port:${menuToken}:${port}`))
    );
  }
  return Markup.inlineKeyboard(buttons);
};

export const locationKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest('Enviar localizacao atual')]])
    .oneTime()
    .resize();
