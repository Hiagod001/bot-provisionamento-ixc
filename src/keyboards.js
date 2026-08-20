import { Markup } from 'telegraf';

export const serviceKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Instalacao', 'service:instalacao')],
    [Markup.button.callback('Mudanca de endereco', 'service:mudanca')],
    [Markup.button.callback('Troca de equipamento', 'service:troca')],
    [Markup.button.callback('Troca de titularidade', 'service:titularidade')],
  ]);

export const titularityKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Transferir para novo titular', 'titularity:transfer')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
  ]);

export const rowsKeyboard = (prefix, rows, labelFn) => {
  const buttons = rows.slice(0, 30).map((row, index) => [
    Markup.button.callback(labelFn(row, index).slice(0, 60), `${prefix}:${index}`),
  ]);
  return Markup.inlineKeyboard(buttons);
};

export const confirmKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Confirmar provisionamento', 'confirm:yes')],
    [Markup.button.callback('Cancelar', 'confirm:no')],
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

export const portsKeyboard = (ports) => {
  const buttons = [];
  for (let index = 0; index < ports.length; index += 4) {
    buttons.push(
      ports
        .slice(index, index + 4)
        .map((port) => Markup.button.callback(String(port), `port:${port}`))
    );
  }
  return Markup.inlineKeyboard(buttons);
};

export const locationKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest('Enviar localizacao atual')]])
    .oneTime()
    .resize();
