export interface DeploymentConfig{
    deployId : string;
    subdomain : string;
    port : number;
    imageName : string;
    /** Port the app listens on inside the container. Defaults to 80. */
    containerPort? : number;
}
