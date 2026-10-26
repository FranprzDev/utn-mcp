export interface EstadoMateria {
    materia: string;
    estado?: string;
    plan?: string;
    anio?: string;
    nota?: string;
    fecha?: string;
    extra?: string[];
}

export interface CorrelatividadMateria {
    materia: string;
    correlativas: string;
    plan?: string;
    anio?: string;
    extra?: string[];
}

export interface Correlatividades {
    cursar: CorrelatividadMateria[];
    rendir?: CorrelatividadMateria[];
}

export interface NotasParcialesMateria {
    materia: string;
    anio?: string;
    comision?: string;
    aula?: string;
    horarios?: string;
    notas?: string;
    inasistencias?: string;
    obs?: string;
    cursando: boolean;
}

export interface ExamenMateria {
    materia: string;
    fecha?: string;
    nota?: string;
    especialidad?: string;
    plan?: string;
    codigo?: string;
}
