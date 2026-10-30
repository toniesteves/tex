// New-project templates. The text follows the interface language; Portuguese uses babel's ini-based locale
// (`provide=*`), which works even where the Portuguese language package is not installed.
import { isPortuguese } from "../i18n";

export interface Template {
  id: string;
  /** English; translated where shown. */
  title: string;
  description: string;
  files: () => Record<string, string>;
}

const L = (pt: string, en: string): string => (isPortuguese() ? pt : en);
const babel = () => L("\\usepackage[brazilian,provide=*]{babel}", "\\usepackage[english]{babel}");

const preamble = (extra: string[] = []) =>
  ["\\usepackage[T1]{fontenc}", babel(), "\\usepackage{lmodern}", "\\usepackage{microtype}", ...extra].join("\n");

const bib = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
`;

export const TEMPLATES: Template[] = [
  {
    id: "article",
    title: "Article",
    description: "Title, abstract, sections and a bibliography.",
    files: () => ({
      "main.tex": `\\documentclass[11pt,a4paper]{article}
${preamble(["\\usepackage{amsmath, amssymb}", "\\usepackage{graphicx}", "\\usepackage{hyperref}"])}

\\title{${L("Título do artigo", "Article title")}}
\\author{${L("Seu nome", "Your name")}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
${L("Um resumo curto do trabalho.", "A short summary of the work.")}
\\end{abstract}

\\section{${L("Introdução", "Introduction")}}\\label{sec:intro}
${L("Comece a escrever aqui. Cite assim:", "Start writing here. Cite like this:")} \\cite{knuth1984}.

\\section{${L("Conclusão", "Conclusion")}}
${L("Veja a Seção", "See Section")}~\\ref{sec:intro}.

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`,
      "refs.bib": bib,
    }),
  },
  {
    id: "thesis",
    title: "Thesis",
    description: "One file per chapter, table of contents and bibliography.",
    files: () => {
      const intro = L("introducao", "introduction");
      const end = L("conclusao", "conclusion");
      return {
        "main.tex": `\\documentclass[12pt,a4paper,oneside]{report}
${preamble(["\\usepackage[margin=3cm]{geometry}", "\\usepackage{amsmath, amssymb, amsthm}", "\\usepackage{graphicx}", "\\usepackage{hyperref}"])}

\\title{${L("Título da tese", "Thesis title")}}
\\author{${L("Seu nome", "Your name")}}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\include{chapters/${intro}}
\\include{chapters/${end}}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`,
        [`chapters/${intro}.tex`]: `% !TEX root = ../main.tex
\\chapter{${L("Introdução", "Introduction")}}\\label{chap:intro}

${L("Cada capítulo fica no seu próprio arquivo.", "Each chapter lives in its own file.")} \\cite{knuth1984}
`,
        [`chapters/${end}.tex`]: `% !TEX root = ../main.tex
\\chapter{${L("Conclusão", "Conclusion")}}

${L("Como visto no Capítulo", "As seen in Chapter")}~\\ref{chap:intro}.
`,
        "refs.bib": bib,
      };
    },
  },
  {
    id: "beamer",
    title: "Presentation",
    description: "Beamer slides, ready for the presenter view.",
    files: () => ({
      "main.tex": `\\documentclass{beamer}
\\usepackage[T1]{fontenc}
${babel()}
\\usetheme{Madrid}
% ${L("Notas do apresentador no segundo monitor:", "Speaker notes on the second screen:")}
% \\setbeameroption{show notes on second screen=right}

\\title{${L("Título da apresentação", "Presentation title")}}
\\author{${L("Seu nome", "Your name")}}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\section{${L("Introdução", "Introduction")}}
\\begin{frame}{${L("Motivação", "Motivation")}}
  \\begin{itemize}
    \\item ${L("Primeiro ponto", "First point")}
    \\item<2-> ${L("Segundo ponto, que aparece depois", "Second point, shown next")}
  \\end{itemize}
  \\note{${L("Comente o segundo ponto.", "Talk about the second point.")}}
\\end{frame}

\\section{${L("Resultados", "Results")}}
\\begin{frame}{${L("Uma equação", "An equation")}}
  \\[ e^{i\\pi} + 1 = 0 \\]
\\end{frame}

\\end{document}
`,
    }),
  },
  {
    id: "notes",
    title: "Math Notes",
    description: "Theorem environments, macros and a section per file.",
    files: () => {
      const [thm, lem, prop, cor, defn, ex, rem] = isPortuguese()
        ? ["Teorema", "Lema", "Proposição", "Corolário", "Definição", "Exemplo", "Observação"]
        : ["Theorem", "Lemma", "Proposition", "Corollary", "Definition", "Example", "Remark"];
      return {
        "main.tex": `\\documentclass[11pt,a4paper]{article}
${preamble(["\\usepackage{amsmath, amssymb, amsthm}", "\\usepackage{hyperref}"])}

\\theoremstyle{plain}
\\newtheorem{theorem}{${thm}}[section]
\\newtheorem{lemma}[theorem]{${lem}}
\\newtheorem{proposition}[theorem]{${prop}}
\\newtheorem{corollary}[theorem]{${cor}}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{${defn}}
\\newtheorem{example}[theorem]{${ex}}
\\theoremstyle{remark}
\\newtheorem*{remark}{${rem}}

\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\N}{\\mathbb{N}}

\\title{${L("Notas de aula", "Lecture notes")}}
\\author{${L("Seu nome", "Your name")}}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\input{sections/${L("sequencias", "sequences")}}
\\end{document}
`,
        [`sections/${L("sequencias", "sequences")}.tex`]: `% !TEX root = ../main.tex
\\section{${L("Sequências", "Sequences")}}\\label{sec:sequences}

\\begin{definition}\\label{def:sequence}
${L("Uma \\emph{sequência} em $\\R$ é uma função $x\\colon \\N \\to \\R$.", "A \\emph{sequence} in $\\R$ is a function $x\\colon \\N \\to \\R$.")}
\\end{definition}

\\begin{theorem}\\label{thm:bounded}
${L("Toda sequência convergente é limitada.", "Every convergent sequence is bounded.")}
\\end{theorem}

\\begin{proof}
${L("Segue da Definição", "It follows from Definition")}~\\ref{def:sequence}.
\\end{proof}
`,
      };
    },
  },
  {
    id: "problems",
    title: "Problem Set",
    description: "Numbered exercises with solutions.",
    files: () => ({
      "main.tex": `\\documentclass[11pt,a4paper]{article}
${preamble(["\\usepackage[margin=2.5cm]{geometry}", "\\usepackage{amsmath, amssymb, amsthm}", "\\usepackage{enumitem}"])}

\\newtheorem{exercise}{${L("Exercício", "Exercise")}}
\\newenvironment{solution}{\\begin{proof}[${L("Solução", "Solution")}]}{\\end{proof}}

\\title{${L("Lista de exercícios 1", "Problem set 1")}}
\\author{${L("Disciplina", "Course")}}
\\date{${L("Entrega", "Due")}: \\today}

\\begin{document}
\\maketitle

\\begin{exercise}
${L("Mostre que $\\sqrt{2}$ é irracional.", "Show that $\\sqrt{2}$ is irrational.")}
\\end{exercise}
\\begin{solution}
${L("Suponha que $\\sqrt{2} = p/q$ com $p, q$ primos entre si.", "Suppose $\\sqrt{2} = p/q$ with $p, q$ coprime.")}
\\end{solution}

\\begin{exercise}
${L("Calcule:", "Compute:")}
\\begin{enumerate}[label=(\\alph*)]
  \\item $\\int_0^1 x^2 \\, dx$
  \\item $\\lim_{n \\to \\infty} (1 + 1/n)^n$
\\end{enumerate}
\\end{exercise}

\\end{document}
`,
    }),
  },
  {
    id: "blank",
    title: "Blank",
    description: "Just the document class.",
    files: () => ({
      "main.tex": `\\documentclass[11pt,a4paper]{article}
\\usepackage[T1]{fontenc}
${babel()}

\\begin{document}


\\end{document}
`,
    }),
  },
];
