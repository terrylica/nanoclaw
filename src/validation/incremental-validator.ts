import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export interface ValidationResult {
  success: boolean;
  errors: ts.Diagnostic[];
  changedFiles: string[];
}

export class IncrementalValidator {
  private readonly tsBuildInfoFile: string;
  private readonly tsConfigPath: string;

  constructor(projectRoot: string) {
    this.tsConfigPath = path.join(projectRoot, 'tsconfig.json');
    this.tsBuildInfoFile = path.join(projectRoot, '.tsbuildinfo');
  }

  validate(changedFiles?: string[]): ValidationResult {
    const configFile = ts.readConfigFile(this.tsConfigPath, ts.sys.readFile);
    if (configFile.error) {
      return {
        success: false,
        errors: [configFile.error],
        changedFiles: [],
      };
    }

    const basePath = path.dirname(this.tsConfigPath);
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      basePath,
    );

    const compilerOptions: ts.CompilerOptions = {
      ...parsedConfig.options,
      incremental: true,
      tsBuildInfoFile: this.tsBuildInfoFile,
    };

    const rootNames =
      changedFiles && changedFiles.length > 0
        ? this.resolveChangedFilesWithDependents(
            changedFiles,
            parsedConfig.fileNames,
            compilerOptions,
          )
        : parsedConfig.fileNames;

    const program = ts.createProgram({
      rootNames,
      options: compilerOptions,
      oldProgram: undefined,
    });

    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];

    // Emit to write .tsbuildinfo without producing output files
    program.emit(undefined, undefined, undefined, true);

    return {
      success: diagnostics.length === 0,
      errors: diagnostics,
      changedFiles: rootNames,
    };
  }

  private resolveChangedFilesWithDependents(
    changedFiles: string[],
    allFiles: string[],
    options: ts.CompilerOptions,
  ): string[] {
    // Build a full program first to resolve the dependency graph
    const fullProgram = ts.createProgram({
      rootNames: allFiles,
      options,
    });

    const changedSet = new Set(changedFiles.map((f) => path.resolve(f)));
    const affected = new Set<string>(changedSet);

    // Walk all source files and find those that import any changed file
    for (const sourceFile of fullProgram.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      const filePath = path.resolve(sourceFile.fileName);
      if (affected.has(filePath)) continue;

      const imports = this.collectImports(sourceFile, fullProgram);
      for (const imported of imports) {
        if (changedSet.has(imported)) {
          affected.add(filePath);
          break;
        }
      }
    }

    return Array.from(affected);
  }

  private collectImports(
    sourceFile: ts.SourceFile,
    program: ts.Program,
  ): string[] {
    const result: string[] = [];
    const checker = program.getTypeChecker();

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const moduleSpecifier = (
          node as ts.ImportDeclaration | ts.ExportDeclaration
        ).moduleSpecifier;
        if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
          const symbol = checker.getSymbolAtLocation(moduleSpecifier);
          const declarations = symbol?.getDeclarations();
          if (declarations && declarations.length > 0) {
            const declFile = declarations[0].getSourceFile().fileName;
            result.push(path.resolve(declFile));
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return result;
  }

  hasCachedBuildInfo(): boolean {
    return fs.existsSync(this.tsBuildInfoFile);
  }

  clearCache(): void {
    if (fs.existsSync(this.tsBuildInfoFile)) {
      fs.unlinkSync(this.tsBuildInfoFile);
    }
  }
}
