# Cofre de notas

Aplicação Next.js multiusuário para notas armazenadas em SQLite com os campos
sensíveis criptografados por usuário.

## Estrutura

- `src/app`: App Router, página e Route Handlers da API;
- `src/components`: interface React; componentes podem permanecer em
  JavaScript quando tipagem não agrega valor;
- `src/server`: criptografia, SQLite, sessões e regras dos cofres;
- `src/proxy.ts`: CSP com nonce e cabeçalhos de segurança;
- `test`: teste de integração que sobe o servidor Next.js real;
- `Dockerfile`: imagem standalone de produção;
- `Dockerfile.test`: build e suíte isolada.

O build usa `output: "standalone"` do Next.js. O esquema SQLite continua
compatível com a versão anterior; volumes existentes não precisam de migração.

## Árvore de páginas

As notas funcionam como páginas organizadas em uma árvore:

- o botão `+` ao lado de uma página cria uma subpágina;
- os ramos podem ser recolhidos e expandidos;
- o seletor **Dentro de** move a página para a raiz ou para outra página;
- páginas podem ter quantos níveis forem necessários;
- ciclos são rejeitados pelo servidor;
- excluir uma página remove toda a subárvore e seus anexos.

A coluna relacional `parent_id` permite montar a árvore e aplicar a exclusão em
cascata. A mesma relação também fica dentro do payload criptografado: se alguém
alterar diretamente a hierarquia no SQLite, a verificação AES-GCM detecta a
divergência. Um banco copiado ainda pode revelar quais identificadores estão
relacionados, mas não os títulos nem o conteúdo dessas páginas.

## Editor e formato

O conteúdo é editado visualmente com Quill (WYSIWYG), convertido para Markdown
antes de ser enviado à API e reconstruído no editor ao abrir a nota. O HTML
gerado a partir do Markdown é sanitizado antes da renderização.

O Markdown fica dentro do payload criptografado no SQLite; ele não é gravado
como um arquivo `.md` legível no volume. Notas da versão anterior, armazenadas
como Quill Delta, continuam abrindo e são convertidas para Markdown no próximo
salvamento.

Imagens e arquivos podem ser adicionados pelo botão abaixo do editor. Cada
anexo é salvo na tabela `attachments`, vinculado à nota e ao usuário. Nome,
tipo MIME e conteúdo usam campos criptografados separados, permitindo listar os
anexos sem descriptografar os bytes do arquivo.

- PNG, JPEG, GIF, WebP e AVIF são exibidos dentro do editor;
- os demais tipos aparecem como links e são baixados como
  `application/octet-stream`;
- o limite é de 10 MiB por arquivo e 100 MiB de anexos por nota;
- excluir uma nota remove seus anexos em cascata;
- excluir um anexo pela lista também remove suas referências do conteúdo.

## Garantias e limites

- Título e conteúdo são criptografados com AES-256-GCM antes de chegarem ao
  SQLite.
- Metadados e bytes dos anexos também são criptografados com AES-256-GCM e
  associados criptograficamente ao usuário, à nota e ao identificador do anexo.
- Cada usuário possui uma chave de dados própria, protegida por uma chave
  derivada da senha com `scrypt`.
- Senhas e chaves abertas não são persistidas.
- O administrador cria convites, mas não consegue abrir cofres de outros
  usuários.
- Não existe recuperação de senha. Perder a senha significa perder
  definitivamente o conteúdo.
- A criptografia protege os dados em repouso. Um processo ou navegador
  comprometido enquanto o cofre estiver aberto ainda poderá observar o
  conteúdo.

## Execução

Todo o projeto roda dentro do Docker. O host precisa apenas de Docker com
Compose; não é necessário instalar Node.js, npm, OpenSSL ou SQLite.

```bash
./deploy.sh
```

Acesse `http://127.0.0.1:3001`. O Compose gera automaticamente o token de
configuração dentro do volume `notes_secrets`.

Para visualizar o token no primeiro acesso:

```bash
docker compose -f docker-compose.production.yml run --rm setup \
  cat /secrets/admin-setup-token
```

O token só cria o primeiro administrador e não descriptografa notas. Depois que
o primeiro usuário existe, o endpoint de configuração fica desativado.

No navegador local, use sempre `http://127.0.0.1:3001`. O endereço
`0.0.0.0:3001` visto em logs é apenas a interface interna do container.

Variáveis disponíveis:

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `PORT` | `3001` | Porta HTTP |
| `HOSTNAME` | `0.0.0.0` | Interface interna do container |
| `NOTES_BIND_ADDRESS` | `127.0.0.1` | Interface publicada no host |
| `NOTES_PORT` | `3001` | Porta publicada no host |
| `NOTES_DB` | `data/notes.sqlite` | Caminho do SQLite |
| `NOTES_ADMIN_SETUP_TOKEN_FILE` | — | Arquivo contendo o token inicial |
| `NOTES_ADMIN_SETUP_TOKEN` | — | Alternativa local ao arquivo secreto |
| `NOTES_HTTPS` | `0` | Use `1` atrás de HTTPS para ativar cookie `Secure` |
| `NOTES_IDLE_MINUTES` | `15` | Minutos sem interação antes do bloqueio automático |

Para acompanhar ou encerrar:

```bash
docker compose -f docker-compose.production.yml logs -f notes
docker compose -f docker-compose.production.yml down
```

`docker compose down` preserva os volumes. Não use `down -v` em produção, pois
isso remove o banco e o token. Também não substitua a publicação da porta por
`3001:3001`: isso disponibilizaria o HTTP na rede. Para uso remoto, coloque o
serviço atrás de HTTPS, defina `NOTES_HTTPS=1` e não exponha diretamente a porta
do container.

## Imagens Docker

### Testes

A imagem de testes instala as dependências a partir do lockfile e executa a
suíte em um ambiente limpo:

```bash
docker compose -f docker-compose.test.yml run --build --rm tests
```

O Compose de testes desabilita a rede, remove capabilities, deixa o filesystem
da imagem somente para leitura e disponibiliza apenas `/tmp` em memória. Nenhum
volume persistente ou secret é usado; o SQLite temporário desaparece ao final.

Também é possível executar a imagem diretamente:

```bash
docker build -f Dockerfile.test -t notes:test .
docker run --rm --network none --read-only --tmpfs /tmp notes:test
```

### Produção

A imagem de produção contém apenas a aplicação e as dependências necessárias,
usa o servidor standalone do Next.js, executa como usuário não-root e possui
healthcheck:

```bash
./deploy.sh
```

O deploy valida os dois arquivos Compose, executa os testes isolados, constrói
a imagem de produção, atualiza os serviços e aguarda o healthcheck. Opções:

```bash
# Porta ou endereço de publicação
NOTES_PORT=8080 NOTES_BIND_ADDRESS=127.0.0.1 ./deploy.sh

# Cookies Secure quando houver um proxy HTTPS
NOTES_HTTPS=1 ./deploy.sh

# Bloquear após 5 minutos sem interação na tela
NOTES_IDLE_MINUTES=5 ./deploy.sh

# Somente para uma repetição em que os testes já foram executados
SKIP_TESTS=1 ./deploy.sh
```

O arquivo [docker-compose.production.yml](docker-compose.production.yml) aplica
filesystem somente para leitura, capabilities removidas, limite de processos,
limite de memória, rotação de logs e volumes separados para dados e token.

## Operação

- O cofre bloqueia após o período configurado sem teclado, mouse, toque ou
  rolagem, no logout ou sempre que o processo reinicia. Antes do bloqueio por
  inatividade, o frontend conclui o autosave pendente e encerra a sessão no
  backend.
- Enquanto existe atividade na tela, um heartbeat autenticado mantém a sessão
  do servidor ativa. O padrão é 15 minutos e pode ser alterado com
  `NOTES_IDLE_MINUTES`.
- Convites administrativos valem por 24 horas e são utilizáveis uma única vez.
- O SQLite usa WAL. Para backup consistente, pare o container antes de copiar o
  volume ou utilize uma ferramenta de backup compatível com SQLite.
- O token inicial não descriptografa notas e não substitui as senhas dos
  usuários.

Não há fluxo de execução ou testes diretamente no host; use sempre os comandos
Docker Compose documentados acima.
