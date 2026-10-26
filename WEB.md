# Acesso web leve

Interface separada do processo Telegram, usando `registerFlow` e o mesmo cliente IXC. Nao instala outro consumidor Telegram. Disponivel em `/`, com login por senha compartilhada. A pagina nao usa mapas, imagens, fontes externas ou bibliotecas de interface.

## Configuracao

Defina `WEB_PASSWORD_HASH` como `salt:scrypt` (salt hexadecimal de 16 bytes, chave hexadecimal de 64 bytes). A funcao `hashWebPassword` de `src/webServer.js` gera esse valor. Nao versionar senha nem arquivo `.env.web`.

Copie as variaveis de `web.env.example` para `/home/agenda/apps/provisionamento-web/.env.web`, com permissao 600. O servico systemd fornecido carrega esse arquivo. Releases web ficam em `/home/agenda/apps/provisionamento-web/releases`, com `current` apontando para a versao ativa. O `.env` IXC e o `node_modules` existentes do bot sao referenciados por links na release; o processo Telegram nao precisa reiniciar. Execute `npm run web` com essas variaveis no ambiente. Para testar localmente use `WEB_ORIGIN=http://127.0.0.1:3080`, `WEB_HOST=127.0.0.1` e `DRY_RUN=true`.

Em producao, configure DNS e HTTPS para `provisionamento.uaitelecom.com.br` e um proxy reverso para `127.0.0.1:3080`. Nao exponha a porta 3080 na Internet. O hostname publico precisa coincidir exatamente com `WEB_ORIGIN`. Nao carregar a interface por HTTP publico: cookies seguros e GPS dependem de HTTPS.

## Garantias e limites

- Senha validada por scrypt; cookie HttpOnly, SameSite=Strict e Secure em HTTPS. Sessao de 8 horas, sem extensao automatica.
- Cinco falhas de login por conexao/IP em 15 minutos bloqueiam novas tentativas. A aplicacao nao confia em X-Forwarded-For. Atras de um proxy local, o limite e agregado: configure tambem rate limiting por IP no proxy.
- Uma operacao por sessao; identificador de solicitacao deduplicado durante toda a sessao. O navegador guarda somente a solicitacao pendente no sessionStorage para recuperar resposta perdida. Nunca guarda a senha.
- Consultas de andamento a cada 3 segundos apenas enquanto ha operacao em curso. Sem polling ocioso, imagens ou mapas.
- Sessoes e recibos ficam em memoria. Apos reinicio/expiracao, o tecnico deve conferir no IXC o resultado antes de repetir; a interface nao reenvia automaticamente operacoes em uma nova sessao.
- O login compartilhado nao identifica individualmente cada tecnico. Nao oferece modo offline nem garantia de deduplicacao entre sessoes diferentes.
- Acesso ao IXC, comandos de provisionamento e credenciais da API ficam no servidor. Os dados do login PPPoE exibidos pelo fluxo sao visiveis apenas na sessao autenticada.
- A interface preserva as validacoes, perfis, excecoes de projetos e confirmacoes do bot. Fotos de orientacao sao substituidas pela legenda textual.

## Verificacao

`npm test` inclui autenticacao, CSRF, bloqueio de tentativas, deduplicacao, concorrencia, logout e fluxo Limpar MAC em simulacao. Nao executar provisionamento real como teste de publicacao. Publicacao deve incluir backup e verificacao HTTPS, GPS no celular e operacao controlada autorizada.
