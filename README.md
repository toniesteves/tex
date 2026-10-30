# Tex

Um editor LaTeX leve, feito para desenvolvedores. Abra a pasta do seu documento e escreva: o PDF acompanha o texto
enquanto você digita, os erros aparecem na linha certa do arquivo certo e um clique leva do PDF ao código (e de volta).
Feito para Linux, com uma interface em português e inglês.

## Recursos

- **Projetos, não só arquivos.** Abra uma pasta (ou um `.tex`, que abre a pasta dele) ou comece por um modelo: Artigo,
  Tese, Apresentação (Beamer), Notas de Matemática, Lista de Exercícios ou Em branco. Árvore de arquivos com menu de
  contexto, abas, Abrir Rápido (Ctrl+P) e a estrutura do documento atravessando todos os arquivos incluídos, com os rótulos.
- **Compilação ao vivo.** Cerca de um segundo depois de você parar de digitar, o PDF mostra o texto ainda **não salvo**,
  sem tocar nos seus arquivos. Salvar (Ctrl+S) ou compilar (Ctrl+B) grava o PDF ao lado do arquivo principal. Nenhum
  `.aux`, `.log` ou `.synctex.gz` vai parar na sua pasta.
- **Arquivo principal e motor automáticos.** O arquivo principal vem do comentário `% !TEX root`, da sua escolha ou de uma
  detecção automática; o motor (pdfLaTeX, XeLaTeX ou LuaLaTeX) vem do `% !TEX program`, da escolha do projeto ou do padrão.
- **Erros no lugar certo.** Erros e avisos do TeX e do BibTeX sublinhados na linha certa, mais avisos imediatos de
  referência indefinida, rótulo duplicado e citação fora da bibliografia. Painel de Problemas com filtro e o log completo.
- **PDF integrado com SyncTeX nos dois sentidos, na palavra exata.** Clique duplo no PDF leva à palavra no código;
  Ctrl+clique no código (ou Ctrl+Shift+J) destaca a palavra no PDF. O PDF recarrega sem piscar e mantém a posição, e os
  links funcionam.
- **Autocompletar.** Comandos, ambientes (`\begin{` já escreve o `\end`), `\end{` com o ambiente aberto primeiro, rótulos
  em `\ref`, chaves em `\cite`, arquivos em `\input` e `\includegraphics`, pacotes, classes e os comandos e ambientes que
  o próprio projeto define. Dentro de matemática, os comandos de matemática vêm primeiro.
- **Apresentação Beamer (F5).** Com dois monitores, a plateia em tela cheia em um e a visão do apresentador no outro
  (slide atual, próximo, notas do Beamer, cronômetro e relógio). Com um monitor, a tecla P mostra a visão do apresentador.
- **Paleta de Comandos (Ctrl+Shift+P)** com tudo o que o app faz, e atalhos editáveis em Ajustes › Atalhos.
- **Modo Vim** opcional, com `:w`, `:wa`, `:q`, `:x` e `:make`.
- Contagem de palavras e páginas, tema claro e escuro (segue o sistema), interface em português e inglês (segue o sistema).

## Instalação

Baixe o pacote `.deb` e instale com o apt, que traz junto o que faltar (`latexmk` e o TeX Live básico):

```sh
sudo apt install ./Tex_0.1.1_amd64.deb
```

O **Tex** aparece no menu do sistema, em Escritório. Para desinstalar: `sudo apt remove tex`.

Se o pacote estiver numa partição que o apt não consegue ler como usuário comum (um disco NTFS, por exemplo), ele avisa
que fez o download "sem isolamento". É inofensivo; para evitar o aviso, copie o `.deb` para `/tmp` antes de instalar.

Para bibliografias com biblatex e biber: `sudo apt install biber`. Pacotes LaTeX que faltarem vêm do apt
(`texlive-latex-extra`, `texlive-science` e outros); no Debian e no Linux Mint o `tlmgr` não instala pacotes.

## Uso

Pelo menu, ou pelo terminal com uma pasta ou um arquivo:

```sh
tex-editor ~/tese
tex-editor capitulo.tex
```

O executável se chama `tex-editor`, não `tex`, porque `tex` é o próprio TeX (`/usr/bin/tex`, do TeX Live).

### Atalhos padrão

| Ação | Atalho | Ação | Atalho |
|---|---|---|---|
| Compilar (salva tudo e grava o PDF) | Ctrl+B | Paleta de Comandos | Ctrl+Shift+P |
| Salvar / Salvar Tudo | Ctrl+S / Ctrl+Alt+S | Abrir Rápido | Ctrl+P |
| Parar a compilação | Ctrl+. | Ajustes | Ctrl+, |
| Mostrar no PDF | Ctrl+Shift+J | Localizar / Substituir | Ctrl+F / Ctrl+H |
| Próximo / anterior problema | F8 / Shift+F8 | Ir para a linha | Ctrl+G |
| Iniciar apresentação | F5 | Comentar/Descomentar | Ctrl+/ |
| Mostrar/Ocultar o PDF | Ctrl+Alt+P | Sugestões | Ctrl+Space (ou Tab) |
| Mostrar/Ocultar Problemas | Ctrl+Shift+M | Novo arquivo / Fechar aba | Ctrl+N / Ctrl+W |
| Mostrar/Ocultar a barra lateral | Ctrl+Alt+B | Abrir pasta / Novo projeto | Ctrl+O / Ctrl+Shift+N |
| Zoom do PDF | Ctrl+= / Ctrl+- / Ctrl+0 | Abas | Ctrl+Tab, Ctrl+1…9 |

Todos podem ser trocados em Ajustes › Atalhos. No modo Vim, com o foco no editor, Ctrl+B, D, E, F, H, R, U, V, W e Y
ficam com o Vim.

## Como funciona

- **Compilação no lugar.** O `latexmk` roda na própria pasta do arquivo principal, então `\input{../macros}`, figuras e
  `.bib` resolvem exatamente como no disco, mas grava tudo num cache em `~/.cache/tex-editor/`. Cada arquivo com
  alterações não salvas é copiado para o cache e trocado pelo original com `\declare@file@substitution`, um recurso do
  próprio LaTeX. Quando dois arquivos do projeto têm o mesmo nome, um pequeno despachante em TeX decide qual versão usar
  a partir do caminho pedido.
- **Rust só para o que precisa do sistema.** A camada em Rust (`src-tauri/src/`) lê e grava arquivos, roda o `latexmk`
  e o `synctex` e observa a pasta. Todo o entendimento de LaTeX fica em TypeScript (`src/`): scanner, índice do projeto,
  leitura do log, autocompletar e a sincronia por palavra.

## Desenvolvimento

Requisitos: Rust (via [rustup](https://rustup.rs)), Node.js 22+, as bibliotecas do WebKitGTK
(`sudo apt install libwebkit2gtk-4.1-dev build-essential`) e o TeX Live com `latexmk`.

```sh
npm install
npm run tauri dev                      # o app, com recarga automática
npm run tauri dev -- -- ~/tese         # já abrindo uma pasta
npm test                               # testes do frontend (vitest)
(cd src-tauri && cargo test)           # testes do Rust, incluindo compilações reais (pulados sem latexmk)
npm run tauri build -- --bundles deb   # pacote em src-tauri/target/release/bundle/deb/
```

Ao gerar um pacote novo, suba a versão em `package.json`, `src-tauri/tauri.conf.json` e `src-tauri/Cargo.toml`. Com a
mesma versão, o apt considera o pacote já instalado e não atualiza.

### Organização do código

| Pasta | Conteúdo |
|---|---|
| `src-tauri/src/` | Arquivos, compilação, SyncTeX e observação da pasta (Rust) |
| `src/latex/` | Scanner, índice do projeto, leitura de log, autocompletar, sincronia por palavra e modelos |
| `src/editor/` | Editor (CodeMirror 6) e realce de LaTeX |
| `src/pdf/` | Visualizador de PDF (pdf.js) |
| `src/present/` | Apresentação: plateia e visão do apresentador |
| `src/ui/` | Telas: boas-vindas, barra lateral, problemas, paleta, ajustes, novo projeto |
| `src/project.ts`, `src/app.ts` | Um projeto aberto; os comandos e as janelas |

## Limitações conhecidas

- Só Linux. Testado no Linux Mint 22.3 (X11, Cinnamon) com o TeX Live 2023.
- A apresentação com dois monitores ainda não foi testada numa máquina real; com um monitor, foi.
- Alterações não salvas em `.bib` só entram na compilação depois de salvar (o BibTeX lê os arquivos direto do disco).
- Um arquivo não salvo cujo nome tem espaços ou caracteres especiais do TeX compila a versão do disco.
- Sem verificação ortográfica.
