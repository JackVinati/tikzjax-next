/**
 * Diagrams written to break a saved run (engine-src/snapshot.ts, internal/DECISIONS.md D32), for
 * scripts/verify-snapshot.mjs. Each has a preamble and two bodies: the first body is drawn from the
 * start and saves the run, then the second and the first again start from it, and every one must
 * come out as it does from the start, byte for byte.
 *
 * `save: false` marks a case that must save nothing: its preamble learns something of the job's own
 * file past the line TeX has read, or never reaches the end of \begin{document}, or takes the
 * snapshot point away. Every other case must save and resume, and its second body must resume from
 * the first's run, but where `shared: false` says the two do not share the text it was saved under.
 */
const B = '\\';
const pic = (inner) => `${B}begin{tikzpicture}\n${inner}\n${B}end{tikzpicture}`;

export const HAZARDS = [
	{
		name: 'counters',
		why: 'a LaTeX counter set in the preamble and stepped in the body starts from the preamble value every time',
		options: { addToPreamble: `${B}newcounter{foo}${B}setcounter{foo}{5}` },
		bodies: [
			pic(`${B}stepcounter{foo}${B}node {${B}thefoo};`),
			pic(`${B}addtocounter{foo}{10}${B}node {${B}thefoo};`),
		],
	},
	{
		name: 'jobname',
		why: `${B}jobname, read in the preamble and in the body`,
		options: { addToPreamble: `${B}edef${B}jn{${B}jobname}` },
		bodies: [pic(`${B}node {${B}jobname/${B}jn};`), pic(`${B}node {[${B}jn]};`)],
	},
	{
		name: 'two-pass',
		why: `a ${B}label resolved by the second pass, which reads the first pass's .aux and starts from the dump`,
		options: { twoPass: true, addToPreamble: `${B}makeatletter${B}def${B}here{x}${B}makeatother` },
		bodies: [
			pic(`${B}refstepcounter{equation}${B}label{e}${B}node {eq ${B}ref{e}};`),
			pic(
				`${B}refstepcounter{equation}${B}refstepcounter{equation}${B}label{f}${B}node {eq ${B}ref{f}};`,
			),
		],
	},
	{
		name: 'write-stream',
		why: `a ${B}write stream opened in the preamble and still open, written in the body`,
		options: {
			addToPreamble: `${B}newwrite${B}out${B}immediate${B}openout${B}out=extra.txt${B}immediate${B}write${B}out{pre}`,
		},
		bodies: [
			pic(`${B}immediate${B}write${B}out{body one}${B}node {a};`),
			pic(`${B}immediate${B}write${B}out{body two}${B}immediate${B}closeout${B}out${B}node {b};`),
		],
		files: ['extra.txt'],
	},
	{
		name: 'read-stream',
		why: `a ${B}read stream opened in the preamble on a bundled file and read on in the body`,
		options: {
			addToPreamble: `${B}newread${B}rd${B}openin${B}rd=pgfcircpath.tex ${B}read${B}rd to${B}first`,
		},
		bodies: [
			pic(`${B}read${B}rd to${B}second ${B}node {${B}meaning${B}second};`),
			pic(`${B}read${B}rd to${B}second ${B}read${B}rd to${B}third ${B}node {${B}meaning${B}third};`),
		],
	},
	{
		name: 'font-metrics-written',
		why: `a body that writes a file named as a bundled font's metrics, eufm10.tfm, which the preamble loads: every later run, resumed or from the start, must load the font as the first did`,
		options: { addToPreamble: `${B}font${B}frak=eufm10 ` },
		bodies: [
			pic(`${B}node {${B}fontname${B}frak};`),
			`${B}newwrite${B}w${B}immediate${B}openout${B}w=eufm10.tfm ${B}immediate${B}write${B}w{not a font}${B}immediate${B}closeout${B}w\n` +
				pic(`${B}node {[${B}fontname${B}frak]};`),
		],
		files: ['eufm10.tfm'],
	},
	{
		name: 'catcodes',
		why: `catcodes left changed by the preamble: an active ! and ${B}makeatletter not undone`,
		options: { addToPreamble: `${B}catcode\`${B}!=13 ${B}def!{X}${B}makeatletter` },
		bodies: [pic(`${B}node {a!b ${B}@firstoftwo{1}{2}};`), pic(`${B}node {!!};`)],
	},
	{
		name: 'preamble-error',
		why: 'an error in the preamble: its message is on the card of every diagram resumed from it',
		options: { addToPreamble: `${B}undefinedinpreamble` },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {b};`)],
	},
	{
		name: 'missing-package',
		why: 'a package the engine does not have, which LaTeX reports and goes on without: the error and the missing file are said again',
		options: { texPackages: { nosuchpackageanywhere: '' } },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {b};`)],
	},
	{
		name: 'body-error',
		why: 'an error in the body of a resumed run, and the line TeX blames',
		options: { texPackages: { amsmath: '' } },
		bodies: [
			pic(`${B}node {a};\n${B}node {${B}nosuchmacro};`),
			pic(`${B}node {a};\n\n\n${B}node {${B}nosuchmacro};`),
		],
	},
	{
		name: 'random',
		why: "pgf's random numbers, drawn in the preamble and in the body, seeded from the fixed clock",
		options: { addToPreamble: `${B}pgfmathrandominteger{${B}pre}{1}{1000000}` },
		bodies: [
			pic(`${B}pgfmathrandominteger{${B}r}{1}{1000000}${B}node {${B}pre, ${B}r};`),
			pic(
				`${B}pgfmathrandominteger{${B}r}{1}{1000000}${B}pgfmathrandominteger{${B}s}{1}{9}${B}node {${B}r, ${B}s};`,
			),
		],
	},
	{
		name: 'clock',
		why: "TeX's date and time",
		options: {},
		bodies: [
			pic(`${B}node {${B}the${B}year-${B}the${B}month-${B}the${B}day${B} ${B}the${B}time};`),
			pic(`${B}node {${B}today};`),
		],
	},
	{
		name: 'shared-preamble',
		why: 'a preamble file of several lines, with commands, styles and an accented letter, shared by two blocks',
		options: {
			texPackages: { amsmath: '' },
			tikzLibraries: 'arrows.meta,calc',
			addToPreamble: `${B}newcommand{${B}R}{${B}mathbb{R}}\n${B}tikzset{my/.style={draw=red,->}}\n${B}newcommand{${B}cafe}{café}\n`,
		},
		bodies: [
			pic(`${B}draw[my] (0,0) -- (1,1) node {$${B}R$ ${B}cafe};`),
			pic(`${B}draw[my,-Latex] ($(0,0)+(1,0)$) -- (2,1);`),
		],
	},
	{
		name: 'own-document',
		why: `a block with its own preamble and ${B}begin{document} (wrap=never, a %!tikz directive)`,
		options: { wrap: 'never' },
		bodies: [
			`${B}usetikzlibrary{calc}\n${B}newcommand{${B}x}{X}\n${B}begin{document}\n${pic(`${B}node {${B}x};`)}\n${B}end{document}`,
			`${B}usetikzlibrary{calc}\n${B}newcommand{${B}x}{X}\n${B}begin{document}\n${pic(`${B}node {${B}x${B}x};`)}\n${B}end{document}`,
		],
	},
	{
		name: 'same-line',
		why: `a block whose ${B}begin{document} has its body on the same line: the run is saved under that whole line`,
		options: { wrap: 'never' },
		bodies: [
			`${B}newcommand{${B}x}{X}\n${B}begin{document}${pic(`${B}node {${B}x};`)}\n${B}end{document}`,
			`${B}newcommand{${B}x}{X}\n${B}begin{document}${pic(`${B}node {${B}x};`)}\n${pic(`${B}node {${B}x${B}x};`)}\n${B}end{document}`,
		],
	},
	{
		name: 'document-in-macro',
		why: `${B}begin{document} given by a macro, where no text of the block says where the preamble ends`,
		options: { wrap: 'never' },
		bodies: [
			`${B}newcommand{${B}go}{${B}begin{document}}\n${B}go\n${pic(`${B}node {a};`)}\n${B}end{document}`,
			`${B}newcommand{${B}go}{${B}begin{document}}\n${B}go\n${pic(`${B}node {bb};`)}\n${B}end{document}`,
		],
	},
	{
		name: 'escaped-percent',
		why: `an escaped % before ${B}begin{document} on its line, which the host took for a comment, so that the run was never saved`,
		options: { wrap: 'never' },
		bodies: [
			`${B}newcommand{${B}pc}{50${B}%}${B}begin{document}\n${pic(`${B}node {${B}pc};`)}\n${B}end{document}`,
			`${B}newcommand{${B}pc}{50${B}%}${B}begin{document}\n${pic(`${B}node {${B}pc, ${B}pc};`)}\n${B}end{document}`,
		],
	},
	{
		name: 'document-nowhere',
		why: `${B}begin{document} written nowhere in the block's text, so that the host has no name for its run: it is saved and resumed all the same`,
		options: { wrap: 'never' },
		bodies: [
			`${B}def${B}startdoc{${B}begin}\n${B}startdoc{document}\n${pic(`${B}node {a};`)}\n${B}end{document}`,
			`${B}def${B}startdoc{${B}begin}\n${B}startdoc{document}\n${pic(`${B}node {bb};`)}\n${B}end{document}`,
		],
	},
	{
		name: 'filecontents',
		why: `a file written by the preamble whose text holds a ${B}begin{document} of its own, ahead of the real one`,
		options: { wrap: 'never' },
		bodies: [
			`${B}begin{filecontents*}{example.tex}\n${B}begin{document}\nexample\n${B}end{document}\n${B}end{filecontents*}\n${B}begin{document}\n${pic(`${B}node {a};`)}\n${B}end{document}`,
			`${B}begin{filecontents*}{example.tex}\n${B}begin{document}\nexample\n${B}end{document}\n${B}end{filecontents*}\n${B}begin{document}\n${pic(`${B}node {b};`)}\n${B}end{document}`,
		],
		files: ['example.tex'],
	},
	{
		name: 'hooks',
		why: `${B}AtBeginDocument and ${B}AtEndDocument code from the preamble`,
		options: {
			addToPreamble: `${B}newcount${B}hits${B}AtBeginDocument{${B}global${B}advance${B}hits by 1 }${B}AtEndDocument{${B}typeout{hits=${B}the${B}hits}}`,
		},
		bodies: [pic(`${B}node {${B}the${B}hits};`), pic(`${B}node {[${B}the${B}hits]};`)],
	},
	{
		name: 'hook-order',
		why: `code for the end of ${B}begin{document} from a package (etoolbox's ${B}AfterEndPreamble), under a label of the preamble's own, and at the top level, which runs after the snapshot point`,
		options: {
			texPackages: { etoolbox: '' },
			addToPreamble:
				`${B}newcount${B}order${B}AfterEndPreamble{${B}global${B}multiply${B}order by 10 ${B}global${B}advance${B}order by 1 }` +
				`${B}AddToHook{begindocument/end}[mine]{${B}global${B}multiply${B}order by 10 ${B}global${B}advance${B}order by 2 }` +
				`${B}AddToHook{begindocument/end}{${B}global${B}multiply${B}order by 10 ${B}global${B}advance${B}order by 3 }`,
		},
		bodies: [pic(`${B}node {${B}the${B}order};`), pic(`${B}node {[${B}the${B}order]};`)],
	},
	{
		name: 'unfinished-line',
		why: `a line of TeX's terminal output still unfinished at the snapshot point, by a ${B}message as the document starts, and finished by the body`,
		options: { addToPreamble: `${B}AtBeginDocument{${B}message{[at the start]}}` },
		bodies: [
			pic(`${B}message{[in the body]}${B}node {a};`),
			pic(`${B}node {b};${B}message{[at the end]}`),
		],
	},
	{
		name: 'batchmode',
		why: `${B}batchmode in the preamble: nothing more on the terminal, everything in input.log`,
		options: { addToPreamble: `${B}batchmode` },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {${B}nosuchmacro};`)],
	},
	{
		name: 'inputlineno',
		why: 'line numbers in the body',
		options: { addToPreamble: 'a\nb' },
		bodies: [pic(`${B}node {${B}the${B}inputlineno};`), pic(`\n\n${B}node {${B}the${B}inputlineno};`)],
	},
	{
		name: 'open-group',
		why: 'a preamble that leaves a group open and a conditional open, closed by the body',
		options: { addToPreamble: `${B}begingroup${B}def${B}inner{in}${B}iftrue` },
		bodies: [
			`${pic(`${B}node {${B}inner};`)}${B}fi${B}endgroup`,
			`${pic(`${B}node {${B}inner${B}inner};`)}${B}fi${B}endgroup`,
		],
	},
	{
		name: 'unicode',
		why: 'characters the Unicode bridge declares, in the preamble and the body, and a name in Chinese',
		options: { addToPreamble: `${B}newcommand{${B}hello}{你好}` },
		bodies: [
			pic(`${B}node (开始) {${B}hello 世界};${B}draw (开始) -- ++(1,0);`),
			pic(`${B}node (开始) {世界 ${B}hello};${B}draw (开始) -- ++(2,0);`),
		],
	},
	{
		name: 'self-read-in-body',
		why: `the body reads the job's own file, its size and its lines, which a resumed run must find to be its own`,
		options: {},
		bodies: [
			pic(
				`${B}newread${B}me${B}newcount${B}nl${B}openin${B}me=${B}jobname.tex ${B}loop${B}unless${B}ifeof${B}me${B}read${B}me to${B}l${B}advance${B}nl by 1 ${B}repeat${B}closein${B}me` +
					`${B}node {${B}filesize{${B}jobname.tex}, ${B}the${B}nl};`,
			),
			pic(
				`${B}newread${B}me${B}newcount${B}nl${B}openin${B}me=${B}jobname.tex ${B}loop${B}unless${B}ifeof${B}me${B}read${B}me to${B}l${B}advance${B}nl by 1 ${B}repeat${B}closein${B}me` +
					`${B}node {${B}filesize{${B}jobname.tex}, ${B}the${B}nl};\n%\n%`,
			),
		],
	},
	{
		name: 'tracing',
		why: `${B}tracingcommands, ${B}tracingmacros and ${B}tracingonline on from the preamble: what the transcript shows of the run`,
		options: { addToPreamble: `${B}tracingonline=1 ${B}tracingcommands=3 ${B}tracingmacros=2 ` },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {b};`)],
	},
	{
		name: 'filesize-self',
		why: 'the preamble asks the size of its own input file, which includes the body',
		options: { addToPreamble: `${B}edef${B}sz{${B}filesize{${B}jobname.tex}}` },
		bodies: [
			pic(`${B}node {${B}sz};`),
			pic(`${B}node {${B}sz};\n% a longer body, so the file is longer\n% and longer still`),
		],
		save: false,
	},
	{
		name: 'read-self',
		why: 'the preamble opens its own input file a second time and reads it to the end, counting the lines, body included',
		options: {
			addToPreamble:
				`${B}newread${B}me${B}newcount${B}nl${B}openin${B}me=${B}jobname.tex ` +
				`${B}loop${B}unless${B}ifeof${B}me${B}read${B}me to${B}l${B}advance${B}nl by 1 ${B}repeat${B}closein${B}me`,
		},
		bodies: [pic(`${B}node {${B}the${B}nl};`), pic(`${B}node {${B}the${B}nl};\n%\n%\n%\n%`)],
		save: false,
	},
	{
		name: 'redefined-point',
		why: 'a preamble that redefines the snapshot command itself: nothing is saved, and the run is as before',
		options: { addToPreamble: `${B}def${B}tikzjaxsnapshot{}` },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {b};`)],
		save: false,
	},
	{
		name: 'fatal-in-preamble',
		why: `a fatal error in the preamble: TeX never reaches the end of ${B}begin{document}`,
		options: { addToPreamble: `${B}input{no-such-file-anywhere}` },
		bodies: [pic(`${B}node {a};`), pic(`${B}node {b};`)],
		save: false,
	},
	{
		name: 'rest-of-line',
		why: `what follows ${B}begin{document} on its line is part of what a saved run stands for: two blocks that differ only there do not share one`,
		options: { wrap: 'never' },
		bodies: [
			`${B}newcommand{${B}x}{X}\n${B}begin{document}${B}def${B}y{1}\n${pic(`${B}node {${B}x${B}y};`)}\n${B}end{document}`,
			`${B}newcommand{${B}x}{X}\n${B}begin{document}${B}def${B}y{2}\n${pic(`${B}node {${B}x${B}y};`)}\n${B}end{document}`,
		],
		shared: false,
	},
];
