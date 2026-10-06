# Bot Telegram de Provisionamento IXC

O menu inicial tambem oferece **Verificar sinal**:

- **Sinal do cliente:** recebe o ID, permite escolher o contrato quando houver mais de um e consulta RX na ONU, TX da ONU e RX na OLT pelo relatorio `botao_rel_22991`.
- **Sinal dos clientes de uma caixa:** recebe a localizacao, lista caixas em ate 300 metros e consulta RX/TX de todos os clientes da caixa escolhida.
- A escolha de contrato mostra plano, status e endereco na mensagem; os botoes exibem apenas `Contrato 1`, `Contrato 2`, etc.
- No relatorio por caixa, o nome do cliente e priorizado e o login e usado somente quando o cliente nao possui nome disponivel.
- ONUs offline ou sem resposta da OLT aparecem de forma resumida, sem expor o retorno tecnico do IXC.

Bot em Node.js para guiar o tecnico pelo provisionamento de ONU no IXC Provedor.

## Fluxo do tecnico

Excecao de Sao Goncalo do Abaete: ONUs da OLT `1105` (`olt_fh_sga`) usam automaticamente a caixa `49904` (`sga-teste`), projeto `37`, com `porta_ftth = 0` (porta nao definida). O tecnico nao informa localizacao, caixa ou porta. O bot verifica se a caixa continua ativa, com esse nome, projeto e OLT; se houver alteracao, bloqueia e solicita verificacao do NOC. A excecao nao libera outras caixas ou cidades fora do Projeto importacao.

A busca de ONUs atualiza cada OLT ativa homologada, com ate tres consultas simultaneas e prazo total de 60 segundos. A listagem global sem filtros pode conter uma fila anterior e nao substitui essa atualizacao. Se a API negar acesso a `radpop_radio`, configure `IXC_PENDING_OLT_IDS` com os IDs conferidos na tela **Autorizar ONUs > Consultar por OLT**; revise essa lista ao adicionar, remover ou desativar uma OLT. Sem descoberta ou lista configurada, o bot informa falha de consulta. Respostas parciais nao comprovam que um serial esta ausente.

Os eventos `onu_refresh`, `onu_olt_failed` e `onu_search` registram horario UTC, cobertura da consulta e os ultimos quatro caracteres do serial. Os logs anteriores a essa instrumentacao nao permitem reconstruir todas as buscas sem resultado. Consultas simultaneas compartilham somente a operacao em andamento; a proxima busca atualiza as OLTs novamente.

1. Escolhe o tipo de servico: instalacao, mudanca de endereco, troca de equipamento ou troca de titularidade.
2. Informa no minimo 4 caracteres do serial e escolhe a ONU pelo serial completo.
3. O bot executa a consulta equivalente ao botao `Consultar todas` e busca a ONU aguardando autorizacao no IXC.
4. Em mudanca de endereco, se existir cadastro antigo, o bot desautoriza a ONU na OLT, exclui o cliente fibra e consulta novamente a fila de ONUs nao autorizadas.
5. O tecnico confirma a ONU pendente antes de enviar a localizacao e escolher caixa/porta.
6. Em troca de equipamento, o bot busca o equipamento antigo pelo contrato escolhido. Se encontrar, limpa o MAC, remove o cadastro antigo e reaproveita caixa/porta. Se nao encontrar, segue como provisionamento novo e solicita localizacao, caixa e porta.
7. Em troca de titularidade, o bot busca a ONU ja provisionada, escolhe o novo cliente/contrato/login, tenta ativar o novo contrato, limpa o MAC do login antigo e transfere o cadastro de fibra para o novo titular.
8. Tecnico envia a localizacao atual pelo Telegram quando o servico exigir nova caixa.
9. Bot lista caixas ativas em ate 300 metros, ordenadas pela distancia.
10. Tecnico escolhe a caixa correta no menu.
11. Bot lista as portas livres da caixa.
12. Tecnico escolhe a porta livre no menu.
13. Tecnico informa ID do cliente.
14. Bot lista os contratos do cliente com endereco/status.
15. Tecnico escolhe o contrato correto.
16. Bot busca o login PPPoE do contrato e valida login/senha contra o CPF ou CNPJ do cliente. Se estiver fora do padrao, bloqueia o fluxo ate o NOC corrigir. Em mudanca de endereco, tambem limpa o MAC antes de provisionar.
17. Bot lista scripts/perfis de provisionamento conforme a OLT.
18. Tecnico confirma, o bot valida se o contrato ja esta ativo e so chama a ativacao quando necessario.
19. Bot cadastra a ONU e executa a autorizacao pela API.
20. Se encontrar outro cliente fibra com o mesmo serial/MAC, desautoriza e exclui o cadastro antigo silenciosamente antes de continuar. Na troca de equipamento, tambem procura pelo login PPPoE, inclusive registros orfaos com contrato zerado.
21. Depois da autorizacao, consulta `Potencia/Resumo ONU` e captura RX/TX da ONU e RX recebido pela OLT.
22. Em segundo plano, cria o atendimento de assunto 7; o workflow gera a OS com os sinais opticos.
23. Bot finaliza a OS com resposta 5 e diagnostico 507, marca `Finaliza atendimento` e salva sem enviar detalhes administrativos ao tecnico.
24. Na mensagem final, script integrado orienta configurar VLAN/PPPoE/senha na ONU; script bridge orienta configurar PPPoE/senha no roteador.

## Configuracao

Copie `.env.example` para `.env` e preencha:

```env
TELEGRAM_BOT_TOKEN=token_do_bot
IXC_BASE_URL=https://seudominio.com.br/webservice/v1
IXC_TOKEN=token_do_usuario_webservice_ixc
IXC_SELF_SIGNED=true
DRY_RUN=true
```

Comece com `DRY_RUN=true`. Nesse modo o bot mostra o payload final, mas nao grava no IXC.

## Comandos

```powershell
npm.cmd install
npm.cmd start
```

Se quiser reiniciar automatico em desenvolvimento:

```powershell
npm.cmd run dev
```

## Endpoints/tabelas IXC usados

Base oficial: `https://SEU_DOMINIO/webservice/v1/{tabela}`.

| Etapa | Tabela IXC | Uso |
| --- | --- | --- |
| ONU aguardando autorizacao | `fh_onu_nao_autorizadas` | Buscar pelo final do serial/MAC e remover da fila apos provisionar |
| OLT/transmissor | `radpop_radio` | Identificar OLT e fabricante/modelo |
| Caixa de atendimento | `rad_caixa_ftth` | Buscar caixa por ID ou descricao |
| Cliente | `cliente` | Conferir nome do cliente |
| Contratos | `cliente_contrato` | Listar contratos do cliente |
| Login PPPoE | `radusuarios` | Buscar login vinculado ao contrato |
| Scripts/perfis | `radpop_radio_cliente_fibra_perfil` | Listar scripts conforme a OLT; OLT 01/02 PMS exibem apenas bridge e integrada correspondentes, e Huawei exibe apenas os perfis exclusivos bridge e integrada |
| Cadastro/provisionamento da ONU | `radpop_radio_cliente_fibra` | Criar a ONU com OLT, caixa, porta, contrato, login e perfil |
| Autorizacao na OLT | `fh_onu_nao_autorizadas_22396` | Autorizar pela API usando o ID original da ONU pendente |
| Gravar no dispositivo | `botao_gravar_dispositivo_22408` | Executar o botao `Autorizar ONU` usando o ID do cliente fibra |
| Potencia/Resumo ONU | `botao_rel_22991` | Consultar RX/TX pelo ID do cliente fibra antes de abrir a OS |
| Atendimento de provisionamento | `su_ticket` | Criar atendimento com assunto 7 e processo 71 |
| Ordem de servico | `su_oss_chamado` | Localizar a OS gerada pelo workflow do atendimento |
| Finalizacao da OS | `su_oss_chamado_fechar` | Executar Acoes > Finalizar, resposta 5, diagnostico 507 e `finaliza_processo=S` |
| Ativacao de contrato | `cliente_contrato_ativar_cliente` | Tentar ativar contrato em instalacao e titularidade somente quando o contrato ainda nao estiver ativo |
| Limpeza de MAC | `radusuarios_25452` | Limpar MAC do login na troca de equipamento e do login antigo na troca de titularidade |

## Observacoes importantes

- O usuario de API no IXC precisa ter permissao para consultar e gravar nessas tabelas.
- O token do Telegram e o token do IXC ficam no `.env`, que esta no `.gitignore`.
- Se o IXC usar certificado autoassinado, mantenha `IXC_SELF_SIGNED=true`.
- Para limitar quem usa o bot, preencha `ALLOWED_TELEGRAM_IDS` com os IDs dos tecnicos separados por virgula.
